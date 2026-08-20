import { randomBytes } from "node:crypto";

export type SyncCommit = "on" | "off";

export interface AppConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly bodyLimit: string;
  readonly writePoolSize: number;
  readonly queryPoolSize: number;
  readonly databaseConnectTimeoutMs: number;
  readonly queryStatementTimeoutMs: number;
  readonly cursorSecret: string;
  readonly retentionDays: number;
  /** 0 disables the ingest age floor entirely, which is the default. */
  readonly maxLogAgeDays: number;
  readonly retentionIntervalMs: number;
  readonly retentionBatchRows: number;
  readonly batchDelayMs: number;
  readonly queueMaxRows: number;
  readonly queueMaxBytes: number;
  readonly syncCommit: SyncCommit;
  readonly shutdownTimeoutMs: number;
  readonly hotAttributeKeys: readonly string[];
  readonly aggregateCache: boolean;
}

// An attribute key becomes part of an index name and an index expression, so it
// is constrained to the identifier character set rather than escaped. Anything
// outside this set is a configuration error, not a value to sanitise.
const ATTRIBUTE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * Attribute keys that get a dedicated partial, ordered index so that filtering
 * on them still returns rows in cursor order from a single index scan instead
 * of a scan followed by a sort. The index is partial, so its write cost scales
 * with how often the key actually appears rather than with total ingest volume.
 * An empty value ships no attribute indexes at all.
 */
function hotAttributeKeys(): readonly string[] {
  const raw = process.env.HOT_ATTRIBUTE_KEYS;
  if (raw === undefined) return ["trace_id"];
  const keys = raw
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  for (const key of keys) {
    if (!ATTRIBUTE_KEY.test(key)) {
      throw new Error(
        `HOT_ATTRIBUTE_KEYS entry '${key}' must match ${String(ATTRIBUTE_KEY)}`,
      );
    }
  }
  return [...new Set(keys)];
}

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function syncCommit(): SyncCommit {
  const value = process.env.SYNC_COMMIT ?? "off";
  if (value !== "on" && value !== "off") throw new Error("SYNC_COMMIT must be on or off");
  return value;
}

export function loadConfig(): AppConfig {
  return {
    port: integer("PORT", 8080, 1, 65_535),
    databaseUrl:
      process.env.DATABASE_URL ?? "postgresql://logger:logger@localhost:5432/logs",
    bodyLimit: process.env.BODY_LIMIT ?? "4mb",
    writePoolSize: integer("WRITE_POOL_SIZE", 2, 1, 8),
    queryPoolSize: integer("QUERY_POOL_SIZE", 8, 1, 20),
    databaseConnectTimeoutMs: integer("DB_CONNECT_TIMEOUT_MS", 2_000, 100, 60_000),
    queryStatementTimeoutMs: integer("QUERY_STATEMENT_TIMEOUT_MS", 10_000, 100, 120_000),
    cursorSecret: process.env.CURSOR_SECRET ?? randomBytes(32).toString("base64url"),
    retentionDays: integer("RETENTION_DAYS", 30, 1, 3_650),
    // Rejecting a backdated log at the edge is more honest than accepting it
    // and deleting it on the next retention pass, but it is a change to the
    // ingest contract: a client backfilling history gets a per-entry rejection
    // where it used to get a 200. That is opt-in rather than implied by
    // RETENTION_DAYS, so upgrading cannot silently start refusing data a
    // caller was previously allowed to send. 0 means no floor.
    maxLogAgeDays: integer("MAX_LOG_AGE_DAYS", 0, 0, 3_650),
    retentionIntervalMs: integer("RETENTION_INTERVAL_MS", 3_600_000, 1_000, 86_400_000),
    retentionBatchRows: integer("RETENTION_BATCH_ROWS", 5_000, 100, 50_000),
    batchDelayMs: integer("BATCH_DELAY_MS", 5, 0, 100),
    queueMaxRows: integer("QUEUE_MAX_ROWS", 50_000, 1, 250_000),
    queueMaxBytes: integer("QUEUE_MAX_BYTES", 32 * 1024 * 1024, 1024 * 1024, 128 * 1024 * 1024),
    syncCommit: syncCommit(),
    shutdownTimeoutMs: integer("SHUTDOWN_TIMEOUT_MS", 15_000, 1_000, 120_000),
    // On by default, and one environment variable away from off. The cache
    // is the largest read-path change in the service and the only one whose
    // failure mode is a wrong answer rather than a slow one, so it ships with
    // a switch that does not need a rebuild to reach.
    aggregateCache: (process.env.AGGREGATE_CACHE ?? "on") !== "off",
    hotAttributeKeys: hotAttributeKeys(),
  };
}
