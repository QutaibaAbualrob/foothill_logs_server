import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";

const MIGRATION_LOCK = "824631947205";
const MIGRATIONS = [
  "001_init.sql",
  "002_attributes_gin.sql",
  "003_ingested_at_and_field_bounds.sql",
  "004_drop_service_level_page_idx.sql",
] as const;

const HOT_ATTRIBUTE_INDEX_PREFIX = "logs_attr_";
// Mirrors the validation in config.ts. Re-asserted here so that this module
// cannot be made to build an identifier from an unvalidated string, whatever
// its caller does.
const ATTRIBUTE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export async function migrate(
  pool: Pool,
  retentionDays: number,
  hotAttributeKeys: readonly string[] = [],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    for (const name of MIGRATIONS) {
      const sql = await readFile(join(process.cwd(), "src", "db", "migrations", name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE name = $1",
        [name],
      );
      if (existing.rowCount === 1) {
        if (existing.rows[0]?.checksum !== checksum) {
          throw new Error(`applied migration ${name} was modified`);
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)",
          [name, checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    await ensureMonthlyPartitions(client, retentionDays);
    await ensureHotAttributeIndexes(client, hotAttributeKeys);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
}

/**
 * Creates one partial, ordered index per configured hot attribute key, and drops
 * the indexes of keys that are no longer configured so that an index nobody
 * queries stops taxing every insert.
 *
 * The index shape — (attributes ->> 'key', timestamp DESC, id DESC) — lets an
 * equality filter on the key return rows already in cursor order, so the page
 * query is a single index scan with no sort node. The WHERE clause makes it
 * partial: rows without the key are not indexed at all, so the write cost
 * scales with how often the key appears rather than with total ingest volume.
 */
export async function ensureHotAttributeIndexes(
  client: Pick<PoolClient, "query">,
  keys: readonly string[],
): Promise<void> {
  const wanted = new Map<string, string>();
  for (const key of keys) {
    if (!ATTRIBUTE_KEY.test(key)) throw new Error(`invalid hot attribute key: ${key}`);
    wanted.set(`${HOT_ATTRIBUTE_INDEX_PREFIX}${key.toLowerCase()}_page_idx`, key);
  }

  // The underscores in the prefix are escaped: LIKE reads a bare _ as
  // "any single character", so an unescaped 'logs_attr_%' also claims every
  // index merely *beginning* with those letters — logs_attributes_gin_idx
  // among them — and this sweep would drop indexes it does not own.
  const existing = await client.query<{ name: string }>(
    `SELECT indexname AS name FROM pg_indexes
     WHERE tablename = 'logs' AND indexname LIKE $1`,
    [`${HOT_ATTRIBUTE_INDEX_PREFIX.replaceAll("_", "\\_")}%`],
  );
  for (const row of existing.rows) {
    if (!wanted.has(row.name)) await client.query(`DROP INDEX IF EXISTS "${row.name}"`);
  }

  for (const [name, key] of wanted) {
    await client.query(
      `CREATE INDEX IF NOT EXISTS "${name}"
       ON logs ((attributes ->> '${key}'), timestamp DESC, id DESC)
       WHERE attributes ? '${key}'`,
    );
  }
}

export async function ensureMonthlyPartitions(
  client: Pick<PoolClient, "query">,
  retentionDays: number,
  now = new Date(),
): Promise<void> {
  const earliest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  earliest.setUTCDate(earliest.getUTCDate() - retentionDays - 35);
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3, 1));
  for (
    let start = new Date(Date.UTC(earliest.getUTCFullYear(), earliest.getUTCMonth(), 1));
    start < last;
    start = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
  ) {
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const name = `logs_${String(start.getUTCFullYear())}_${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF logs
       FOR VALUES FROM ('${start.toISOString()}') TO ('${end.toISOString()}')`,
    );
    await client.query(
      `ALTER TABLE ${name} SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01)`,
    );
  }
}
