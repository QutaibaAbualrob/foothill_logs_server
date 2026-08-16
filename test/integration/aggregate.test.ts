import assert from "node:assert/strict";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { loadConfig } from "../../src/config.js";
import { migrate } from "../../src/db/migrate.js";
import { PgLogWriteRepository } from "../../src/ingest/repository.js";
import { CursorCodec } from "../../src/query/cursor.js";
import { PgLogQueryRepository } from "../../src/query/repository.js";
import type { NormalizedLog } from "../../src/types.js";

const SERVICE = "t07_aggregate_test";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === "") {
  console.log("skipped: TEST_DATABASE_URL unset");
  process.exit(0);
}

// Seed relative to a recent minute boundary so the rows are seconds old:
// they can never collide with the retention test's 30-day cutoff, which lets
// both integration files run concurrently against one test database.
const MINUTE_MS = 60_000;
const baseMs = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS - 10 * MINUTE_MS;
const iso = (offsetMs: number): string => new Date(baseMs + offsetMs).toISOString();

function log(offsetMs: number, level: "info" | "error"): NormalizedLog {
  const timestamp = iso(offsetMs);
  const attributes = { seeded: true };
  const attributesJson = JSON.stringify(attributes);
  return {
    timestamp,
    level,
    service: SERVICE,
    message: `aggregate test ${timestamp}`,
    attributes,
    attributesJson,
    estimatedBytes: attributesJson.length + timestamp.length + 64,
  };
}

// Minute 0 gets rows at .100 and 40 seconds; minutes 1-4 get rows at fixed
// offsets. Rollup counts are computed by the real write repository.
const SEED: NormalizedLog[] = [
  log(100, "info"),
  log(40_000, "info"),
  log(MINUTE_MS + 10_000, "info"),
  log(MINUTE_MS + 40_000, "error"),
  log(2 * MINUTE_MS + 20_000, "info"),
  log(3 * MINUTE_MS + 30_000, "error"),
  log(4 * MINUTE_MS + 50_000, "info"),
];

test("aggregate: aligned range, unaligned range, and raw path agree with SQL truth", async () => {
  process.env.HOT_ATTRIBUTE_KEYS = "";
  const config = loadConfig();
  const pool = new Pool({ connectionString: databaseUrl });
  let client: PoolClient | undefined;
  try {
    await migrate(pool, config.retentionDays, []);
    client = await pool.connect();
    const db = client;

    const writes = new PgLogWriteRepository(pool, config.syncCommit);
    await writes.insertCommitted(SEED);

    const queries = new PgLogQueryRepository(pool, new CursorCodec("test"), []);
    // Every query carries the service filter: the shared test database may hold
    // rows from other integration files inside the same time range, and the
    // truth query is service-scoped.
    const filters = (since: string, until: string) => ({ since, until, attributes: {}, service: SERVICE });
    const queryAggregate = async (
      since: string,
      until: string,
      bucket: "1m" | "5m" | "1h",
      groupBy?: "service" | "level",
    ) =>
      queries.aggregate({
        filters: filters(since, until),
        bucket,
        ...(groupBy === undefined ? {} : { groupBy }),
      });
    const truth = async (since: string, until: string): Promise<Map<string, number>> => {
      const result = await db.query<{ start: string; count: string }>(
        `SELECT to_char(to_timestamp(floor(extract(epoch FROM timestamp) / 60) * 60)
                    AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS start,
                COUNT(*)::text AS count
         FROM logs
         WHERE timestamp >= $1::timestamptz AND timestamp < $2::timestamptz AND service = $3
         GROUP BY 1 ORDER BY 1`,
        [since, until, SERVICE],
      );
      return new Map(result.rows.map((row) => [row.start, Number(row.count)]));
    };
    const assertMatches = (actual: { start: string; count: number }[], expected: Map<string, number>, label: string) => {
      assert.deepEqual(new Map(actual.map((row) => [row.start, row.count])), expected, `${label}: buckets must match SQL truth`);
    };

    // 1. Aligned range — answered by the rollup interior.
    assertMatches(
      await queryAggregate(iso(0), iso(5 * MINUTE_MS), "1m"),
      await truth(iso(0), iso(5 * MINUTE_MS)),
      "aligned range",
    );

    // 2. Unaligned range — edge slices must contribute only their in-range
    //    portion. Minute 0 holds rows at .100 and .900; a range starting at
    //    00:00:30 may only count the .900 row. A naive whole-minute rollup
    //    would count both.
    assertMatches(
      await queryAggregate(iso(30_000), iso(3 * MINUTE_MS + 30_000), "1m"),
      await truth(iso(30_000), iso(3 * MINUTE_MS + 30_000)),
      "unaligned range",
    );
    const unaligned = await queryAggregate(iso(30_000), iso(3 * MINUTE_MS + 30_000), "1m");
    const minuteZero = iso(0).replace(/\.\d{3}Z$/, ".000000Z");
    assert.equal(
      unaligned.find((row) => row.start === minuteZero)?.count,
      1,
      "the partial edge minute must count only the row inside the unaligned range",
    );

    // 3. Raw-forced path (q present forces the raw table) over the same
    //    unaligned range. Every seeded message contains the q needle, so the
    //    filter set matches the same rows and the counts must be identical.
    const raw = await queries.aggregate({
      filters: { ...filters(iso(30_000), iso(3 * MINUTE_MS + 30_000)), q: "aggregate test" },
      bucket: "1m",
    });
    assert.deepEqual(
      new Map(raw.map((row) => [row.start, row.count])),
      new Map(unaligned.map((row) => [row.start, row.count])),
      "raw path and edge-slice path must return identical counts for the same range",
    );

    // 4. Grouped totals sum to the ungrouped total over the same range.
    const grouped = await queryAggregate(iso(0), iso(5 * MINUTE_MS), "1m", "level");
    const ungrouped = await queryAggregate(iso(0), iso(5 * MINUTE_MS), "1m");
    assert.equal(
      grouped.reduce((sum, row) => sum + row.count, 0),
      ungrouped.reduce((sum, row) => sum + row.count, 0),
      "grouped counts must sum to the ungrouped total",
    );
  } finally {
    await client?.query("DELETE FROM logs WHERE service = $1", [SERVICE]).catch(() => undefined);
    await client?.query("DELETE FROM logs_agg_1m WHERE service = $1", [SERVICE]).catch(() => undefined);
    client?.release();
    await pool.end();
  }
});
