import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../config.js";
import { ensureMonthlyPartitions } from "../db/migrate.js";

const RETENTION_LOCK = "824631947206";
const DAY_MS = 86_400_000;
const MAX_BATCHES_PER_PASS = 20;

export class RetentionWorker {
  private client: PoolClient | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopping = false;
  private running: Promise<void> | undefined;

  public constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
  ) {}

  public async start(): Promise<void> {
    this.client = await this.pool.connect();
    const result = await this.client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [RETENTION_LOCK],
    );
    if (result.rows[0]?.acquired !== true) {
      this.client.release();
      this.client = undefined;
      return;
    }
    this.schedule(1_000);
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
    if (this.client !== undefined) {
      await this.client.query("SELECT pg_advisory_unlock($1::bigint)", [RETENTION_LOCK]).catch(() => undefined);
      this.client.release();
      this.client = undefined;
    }
  }

  private schedule(delay: number): void {
    if (this.stopping || this.client === undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.runPass()
        .catch((error: unknown) => {
          console.error(JSON.stringify({
            event: "retention_error",
            message: error instanceof Error ? error.message : "unknown error",
          }));
        })
        .finally(() => {
          this.running = undefined;
          this.schedule(this.config.retentionIntervalMs);
        });
    }, delay);
  }

  private async runPass(): Promise<void> {
    const client = this.client;
    if (client === undefined) return;
    const cutoff = new Date(Date.now() - this.config.retentionDays * DAY_MS);
    await ensureMonthlyPartitions(client, this.config.retentionDays);
    await dropExpiredPartitions(client, cutoff);

    let deleted = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_PASS && !this.stopping; batch += 1) {
      const result = await client.query(
        `WITH doomed AS (
           SELECT timestamp, id
           FROM logs
           WHERE timestamp < $1::timestamptz
           ORDER BY timestamp, id
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         DELETE FROM logs target
         USING doomed
         WHERE target.timestamp = doomed.timestamp AND target.id = doomed.id`,
        [cutoff.toISOString(), this.config.retentionBatchRows],
      );
      const count = result.rowCount ?? 0;
      deleted += count;
      if (count < this.config.retentionBatchRows) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const oldRows = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM logs WHERE timestamp < $1::timestamptz LIMIT 1) AS exists",
      [cutoff.toISOString()],
    );
    if (oldRows.rows[0]?.exists === false) await rebuildRollupBoundary(client, cutoff);
    console.log(JSON.stringify({ event: "retention_pass", cutoff: cutoff.toISOString(), deleted }));
  }
}

async function dropExpiredPartitions(client: PoolClient, cutoff: Date): Promise<void> {
  const result = await client.query<{ name: string }>(`
    SELECT child.relname AS name
    FROM pg_inherits
    JOIN pg_class parent ON parent.oid = inhparent
    JOIN pg_class child ON child.oid = inhrelid
    WHERE parent.relname = 'logs' AND child.relname ~ '^logs_[0-9]{4}_[0-9]{2}$'
  `);
  for (const row of result.rows) {
    const match = /^logs_(\d{4})_(\d{2})$/.exec(row.name);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const partitionEnd = new Date(Date.UTC(year, month, 1));
    if (partitionEnd <= cutoff) await client.query(`DROP TABLE IF EXISTS "${row.name}"`);
  }
}

async function rebuildRollupBoundary(client: PoolClient, cutoff: Date): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      `DELETE FROM logs_agg_1m
       WHERE bucket_start < date_trunc('minute', $1::timestamptz) + interval '1 minute'`,
      [cutoff.toISOString()],
    );
    await client.query(
      `INSERT INTO logs_agg_1m (bucket_start, service, level, count)
       SELECT date_trunc('minute', timestamp), service, level, COUNT(*)
       FROM logs
       WHERE timestamp >= date_trunc('minute', $1::timestamptz)
         AND timestamp < date_trunc('minute', $1::timestamptz) + interval '1 minute'
       GROUP BY 1, 2, 3
       ON CONFLICT (bucket_start, service, level)
       DO UPDATE SET count = EXCLUDED.count`,
      [cutoff.toISOString()],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
