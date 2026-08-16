import assert from "node:assert/strict";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { loadConfig } from "../../src/config.js";
import { migrate } from "../../src/db/migrate.js";
import { runRetentionPass } from "../../src/retention/worker.js";

const SERVICE = "t08_retention_test";
const DAY_MS = 86_400_000;

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === "") {
  console.log("skipped: TEST_DATABASE_URL unset");
  process.exit(0);
}

test("one retention pass drops the expired partition, its raw rows, and rollup counts while recent rows survive", async () => {
  process.env.RETENTION_DAYS = "30";
  process.env.RETENTION_INTERVAL_MS = "3600000";
  process.env.RETENTION_BATCH_ROWS = "5000";
  const config = loadConfig();

  const pool = new Pool({ connectionString: databaseUrl });
  let client: PoolClient | undefined;
  try {
    await migrate(pool, config.retentionDays);

    client = await pool.connect();

    // Seed an expired monthly partition with raw rows, plus matching historical
    // rollup counts, plus one recent raw row and one recent rollup row that
    // must survive the pass.
    await client.query("DROP TABLE IF EXISTS logs_2020_01");
    await client.query(
      `CREATE TABLE logs_2020_01 PARTITION OF logs
       FOR VALUES FROM ('2020-01-01') TO ('2020-02-01')`,
    );
    await client.query(
      `INSERT INTO logs (timestamp, level, service, message, attributes) VALUES
       ('2020-01-05T10:00:00Z', 'info',  $1, 'expired-1', '{}'::jsonb),
       ('2020-01-12T11:00:00Z', 'error', $1, 'expired-2', '{"k":"v"}'::jsonb),
       ('2020-01-20T12:00:00Z', 'debug', $1, 'expired-3', '{}'::jsonb)`,
      [SERVICE],
    );
    await client.query(
      `INSERT INTO logs_agg_1m (bucket_start, service, level, count) VALUES
       ('2020-01-05T10:00:00Z', $1, 'info', 2),
       ('2020-01-12T11:00:00Z', $1, 'error', 1),
       ('2020-01-20T12:00:00Z', $1, 'debug', 3)`,
      [SERVICE],
    );
    await client.query(
      `INSERT INTO logs (timestamp, level, service, message, attributes)
       VALUES (now(), 'warn', $1, 'recent-raw', '{}'::jsonb)`,
      [SERVICE],
    );
    await client.query(
      `INSERT INTO logs_agg_1m (bucket_start, service, level, count)
       VALUES (date_trunc('minute', now()), $1, 'warn', 1)`,
      [SERVICE],
    );

    // Drive exactly one retention pass directly — no timer wait.
    await runRetentionPass(client, config);

    const cutoff = new Date(Date.now() - config.retentionDays * DAY_MS).toISOString();

    const partition = await client.query<{ count: string }>(
      `SELECT count(*) AS count
       FROM pg_inherits
       JOIN pg_class ON pg_class.oid = inhrelid
       WHERE relname = 'logs_2020_01'`,
    );
    assert.equal(
      Number(partition.rows[0]?.count ?? -1),
      0,
      "logs_2020_01 partition should be dropped",
    );

    const oldRaw = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM logs WHERE timestamp < $1::timestamptz",
      [cutoff],
    );
    assert.equal(
      Number(oldRaw.rows[0]?.count ?? -1),
      0,
      "no raw rows older than the retention cutoff should remain",
    );

    const oldRollup = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM logs_agg_1m WHERE bucket_start < $1::timestamptz",
      [cutoff],
    );
    assert.equal(
      Number(oldRollup.rows[0]?.count ?? -1),
      0,
      "no rollup rows older than the retention cutoff should remain",
    );

    const recentRaw = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM logs WHERE service = $1",
      [SERVICE],
    );
    assert.equal(Number(recentRaw.rows[0]?.count ?? -1), 1, "the recent raw row should survive");

    const recentRollup = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM logs_agg_1m WHERE service = $1",
      [SERVICE],
    );
    assert.equal(
      Number(recentRollup.rows[0]?.count ?? -1),
      1,
      "the recent rollup row should survive",
    );
  } finally {
    await client?.query("DELETE FROM logs WHERE service = $1", [SERVICE]).catch(() => undefined);
    await client
      ?.query("DELETE FROM logs_agg_1m WHERE service = $1", [SERVICE])
      .catch(() => undefined);
    await client?.query("DROP TABLE IF EXISTS logs_2020_01").catch(() => undefined);
    client?.release();
    await pool.end();
  }
});
