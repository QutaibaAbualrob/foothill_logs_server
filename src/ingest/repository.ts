import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Pool, PoolClient } from "pg";
import { from as copyFrom } from "pg-copy-streams";
import type { SyncCommit } from "../config.js";
import type { NormalizedLog } from "../types.js";

export interface LogWriteRepository {
  insertCommitted(logs: readonly NormalizedLog[]): Promise<void>;
}

interface RollupDelta {
  readonly bucket: string;
  readonly service: string;
  readonly level: string;
  count: number;
}

const COPY_CHUNK_BYTES = 64 * 1024;

export class PgLogWriteRepository implements LogWriteRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly syncCommit: SyncCommit,
  ) {}

  public async insertCommitted(logs: readonly NormalizedLog[]): Promise<void> {
    if (logs.length === 0) return;
    const rollups = computeRollups(logs);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL synchronous_commit = ${this.syncCommit}`);
      const stream = client.query(
        copyFrom(
          "COPY logs (timestamp, level, service, message, attributes) FROM STDIN WITH (FORMAT csv)",
        ),
      );
      await pipeline(Readable.from(csvChunks(logs)), stream);
      await upsertRollups(client, rollups);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function* csvChunks(logs: readonly NormalizedLog[]): Generator<string> {
  let chunk = "";
  for (const log of logs) {
    chunk += `${csv(log.timestamp)},${csv(log.level)},${csv(log.service)},${csv(log.message)},${csv(log.attributesJson)}\n`;
    if (chunk.length >= COPY_CHUNK_BYTES) {
      yield chunk;
      chunk = "";
    }
  }
  if (chunk.length > 0) yield chunk;
}

function csv(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

function computeRollups(logs: readonly NormalizedLog[]): RollupDelta[] {
  const byKey = new Map<string, RollupDelta>();
  for (const log of logs) {
    const epochMs = Date.parse(log.timestamp);
    const bucket = new Date(Math.floor(epochMs / 60_000) * 60_000).toISOString();
    const key = `${bucket}\u0000${log.service}\u0000${log.level}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, { bucket, service: log.service, level: log.level, count: 1 });
    } else {
      existing.count += 1;
    }
  }
  return [...byKey.values()].sort((left, right) => {
    if (left.bucket !== right.bucket) return left.bucket.localeCompare(right.bucket);
    if (left.service !== right.service) return left.service.localeCompare(right.service);
    return left.level.localeCompare(right.level);
  });
}

async function upsertRollups(client: PoolClient, deltas: readonly RollupDelta[]): Promise<void> {
  if (deltas.length === 0) return;
  await client.query(
    `INSERT INTO logs_agg_1m (bucket_start, service, level, count)
     SELECT * FROM UNNEST($1::timestamptz[], $2::text[], $3::text[], $4::bigint[])
     ON CONFLICT (bucket_start, service, level)
     DO UPDATE SET count = logs_agg_1m.count + EXCLUDED.count`,
    [
      deltas.map((item) => item.bucket),
      deltas.map((item) => item.service),
      deltas.map((item) => item.level),
      deltas.map((item) => item.count),
    ],
  );
}
