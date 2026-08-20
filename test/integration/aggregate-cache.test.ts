import assert from "node:assert/strict";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { AggregateCounters } from "../../src/aggregate/counters.js";
import { loadConfig } from "../../src/config.js";
import { migrate } from "../../src/db/migrate.js";
import { PgLogWriteRepository } from "../../src/ingest/repository.js";
import { CursorCodec } from "../../src/query/cursor.js";
import { PgLogQueryRepository } from "../../src/query/repository.js";
import type { Bucket } from "../../src/query/types.js";
import type { LogLevel, NormalizedLog } from "../../src/types.js";

/**
 * The abort gate for the in-process aggregate counters.
 *
 * A cache that is merely fast is worthless: a client draining the log compares
 * the aggregate answer against the exact number of rows it was acknowledged
 * for, so any disagreement with SQL is a correctness defect rather than a
 * performance one. Every assertion here is exact equality against the database,
 * and the randomised sweep exists to find the window shape a hand-picked
 * example would miss.
 *
 * It also asserts the mechanism, not just the answer. A cache that silently
 * declines every query would satisfy parity perfectly while buying nothing, so
 * the query counter below proves the covered case reaches PostgreSQL zero
 * times.
 */

const SERVICES = ["t08_cache_a", "t08_cache_b", "t08_cache_c"] as const;
const LEVELS: readonly LogLevel[] = ["info", "warn", "error"];
const BUCKETS: readonly Bucket[] = ["1m", "5m", "1h", "1d"];

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === "") {
  console.log("skipped: TEST_DATABASE_URL unset");
  process.exit(0);
}

// Far enough back that the other integration files cannot overlap it — the
// aggregate suite seeds ten minutes ago and the retention suite thirty days —
// and far enough forward to sit well inside the counters' two-hour window.
// Unfiltered queries in this file therefore see this file's rows and no others.
const SECOND_MS = 1_000;
const SPAN_SECONDS = 150;
const baseMs = Math.floor((Date.now() - 45 * 60 * SECOND_MS) / SECOND_MS) * SECOND_MS;

/** Sub-second offsets, so boundary seconds are populated and edges are real. */
const SUB_SECOND_MS = [0, 137, 500, 899];

function log(offsetMs: number, service: string, level: LogLevel): NormalizedLog {
  const timestamp = new Date(baseMs + offsetMs).toISOString();
  const attributes = {};
  const attributesJson = "{}";
  return {
    timestamp,
    level,
    service,
    message: `cache parity ${timestamp}`,
    attributes,
    attributesJson,
    estimatedBytes: attributesJson.length + timestamp.length + 64,
  };
}

/** Deterministic, so a failure is reproducible from the printed window alone. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * A pool that counts statements. The repository only ever calls `query`, so
 * everything else delegates untouched and the wrapper stays a Pool to pg.
 */
function countingPool(pool: Pool, onQuery: () => void): Pool {
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property !== "query") return Reflect.get(target, property, receiver) as unknown;
      return (...args: unknown[]): unknown => {
        onQuery();
        const original = Reflect.get(target, "query", target) as (...a: unknown[]) => unknown;
        return Reflect.apply(original, target, args);
      };
    },
  });
}

// Two-thirds of the rows are inserted before hydration and one-third after, so
// a single fixture exercises both ways a row can reach the counters: read out
// of the table at startup, and added post-commit while running. A cache that
// hydrates correctly but never increments — or the reverse — fails here.
const SEEDED: NormalizedLog[] = [];
const STREAMED: NormalizedLog[] = [];
for (let second = 0; second < SPAN_SECONDS; second += 1) {
  for (const [index, subMs] of SUB_SECOND_MS.entries()) {
    const service = SERVICES[(second + index) % SERVICES.length] ?? SERVICES[0];
    const level = LEVELS[(second * SUB_SECOND_MS.length + index) % LEVELS.length] ?? "info";
    const entry = log(second * SECOND_MS + subMs, service, level);
    (second < (SPAN_SECONDS * 2) / 3 ? SEEDED : STREAMED).push(entry);
  }
}

const cleanupServices = [...SERVICES, `${SERVICES[0]}-consistency-probe`];

async function withFixture(
  body: (context: {
    counters: AggregateCounters;
    cached: PgLogQueryRepository;
    direct: PgLogQueryRepository;
    client: PoolClient;
    queryCount: () => number;
    resetQueryCount: () => void;
  }) => Promise<void>,
): Promise<void> {
  process.env.HOT_ATTRIBUTE_KEYS = "";
  const config = loadConfig();
  const pool = new Pool({ connectionString: databaseUrl });
  let client: PoolClient | undefined;
  try {
    await migrate(pool, config.retentionDays, []);
    client = await pool.connect();
    const writes = new PgLogWriteRepository(pool, config.syncCommit);

    // Everything present before the counters exist must arrive via hydration.
    await writes.insertCommitted(SEEDED);

    const counters = new AggregateCounters();
    await counters.hydrate(pool);
    assert.equal(counters.enabled, true, "hydration must leave the cache usable");
    assert.ok(counters.size > 0, "hydration must load cells from the seeded rows");

    // The rest arrive the way the batcher delivers them: committed, then
    // counted, before the ingest request would have resolved.
    await writes.insertCommitted(STREAMED);
    counters.add(STREAMED);

    let queries = 0;
    const counted = countingPool(pool, () => {
      queries += 1;
    });
    const codec = new CursorCodec("test");
    await body({
      counters,
      cached: new PgLogQueryRepository(counted, codec, [], counters),
      // No counters: the same code, forced down the SQL path, which is what
      // "agrees with SQL" has to mean for the comparison to be worth anything.
      direct: new PgLogQueryRepository(pool, codec, []),
      client,
      queryCount: () => queries,
      resetQueryCount: () => {
        queries = 0;
      },
    });
  } finally {
    for (const service of cleanupServices) {
      await client?.query("DELETE FROM logs WHERE service = $1", [service]).catch(() => undefined);
      await client
        ?.query("DELETE FROM logs_agg_1m WHERE service = $1", [service])
        .catch(() => undefined);
    }
    client?.release();
    await pool.end();
  }
}

/** COUNT(*) straight from the raw table — the truth both paths must reproduce. */
async function truth(
  client: PoolClient,
  since: string,
  until: string,
  bucketSeconds: number,
  service: string | undefined,
  level: LogLevel | undefined,
): Promise<Map<string, number>> {
  const conditions = ["timestamp >= $1::timestamptz", "timestamp < $2::timestamptz"];
  const values: unknown[] = [since, until];
  if (service !== undefined) {
    values.push(service);
    conditions.push(`service = $${String(values.length)}`);
  }
  if (level !== undefined) {
    values.push(level);
    conditions.push(`level = $${String(values.length)}`);
  }
  const result = await client.query<{ start: string; count: string }>(
    `SELECT to_char(to_timestamp(floor(extract(epoch FROM timestamp) / ${String(bucketSeconds)}) * ${String(bucketSeconds)})
                AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS start,
            COUNT(*)::text AS count
     FROM logs
     WHERE ${conditions.join(" AND ")}
     GROUP BY 1 ORDER BY 1`,
    values,
  );
  return new Map(result.rows.map((row) => [row.start, Number(row.count)]));
}

const BUCKET_SECONDS: Record<Bucket, number> = { "1m": 60, "5m": 300, "1h": 3_600, "1d": 86_400 };

test("aggregate cache: randomised windows, filters and buckets agree with SQL exactly", async () => {
  await withFixture(async ({ cached, direct, client }) => {
    const random = mulberry32(20_260_820);
    const spanMs = SPAN_SECONDS * SECOND_MS;
    for (let iteration = 0; iteration < 120; iteration += 1) {
      // Windows are allowed to start before and end after the seeded span, so
      // empty edges, partly-covered edges and fully-interior windows all occur.
      const startOffset = Math.floor(random() * (spanMs + 20_000)) - 10_000;
      const width = 1 + Math.floor(random() * (spanMs + 20_000));
      const since = new Date(baseMs + startOffset).toISOString();
      const until = new Date(baseMs + startOffset + width).toISOString();
      const bucket = BUCKETS[Math.floor(random() * BUCKETS.length)] ?? "1m";
      const filterRoll = random();
      const service =
        filterRoll < 0.5 ? (SERVICES[Math.floor(random() * SERVICES.length)] ?? SERVICES[0]) : undefined;
      const level =
        filterRoll > 0.75 ? (LEVELS[Math.floor(random() * LEVELS.length)] ?? "info") : undefined;

      const filters = {
        since,
        until,
        attributes: {},
        ...(service === undefined ? {} : { service }),
        ...(level === undefined ? {} : { level }),
      };
      const label = `iteration ${String(iteration)} ${since}..${until} ${bucket} service=${String(service)} level=${String(level)}`;

      const fromCache = await cached.aggregate({ filters, bucket });
      const fromSql = await direct.aggregate({ filters, bucket });
      assert.deepEqual(fromCache, fromSql, `${label}: cache and SQL paths must be identical`);
      assert.deepEqual(
        new Map(fromCache.map((row) => [row.start, row.count])),
        await truth(client, since, until, BUCKET_SECONDS[bucket], service, level),
        `${label}: cache must match raw SQL truth`,
      );
      assert.ok(
        fromCache.every((row) => row.group === null),
        `${label}: an ungrouped aggregate must carry a null group on every row`,
      );
    }
  });
});

test("aggregate cache: the read-after-write drain shapes", async () => {
  await withFixture(async ({ cached, direct, client }) => {
    const spanEndMs = baseMs + SPAN_SECONDS * SECOND_MS;

    // 1. The drain query: a service filter, day buckets, and an until roughly
    //    a minute in the future. A coverage rule that demanded the window end
    //    at or before the newest row would quietly route this to SQL — fast
    //    enough to look healthy, and worth nothing.
    const probeService = SERVICES[0];
    const probeSince = new Date(baseMs).toISOString();
    const probeUntil = new Date(Date.now() + 60 * SECOND_MS).toISOString();
    const probeFilters = { since: probeSince, until: probeUntil, attributes: {}, service: probeService };
    const probe = await cached.aggregate({ filters: probeFilters, bucket: "1d" });
    assert.deepEqual(
      probe,
      await direct.aggregate({ filters: probeFilters, bucket: "1d" }),
      "day buckets over a future-ending window must match the SQL path",
    );
    assert.deepEqual(
      new Map(probe.map((row) => [row.start, row.count])),
      await truth(client, probeSince, probeUntil, 86_400, probeService, undefined),
      "day buckets over a future-ending window must match SQL truth",
    );
    assert.equal(
      probe.reduce((sum, row) => sum + row.count, 0),
      [...SEEDED, ...STREAMED].filter((entry) => entry.service === probeService).length,
      "the drain total must equal every row seeded for that service",
    );

    // 2. The filter-honesty sentinel. A cautious client asks for a service it
    //    knows cannot exist before trusting any of the answers, and abandons
    //    the cheap path unless that comes back a valid, empty, service-scoped
    //    result. A total that quietly ignored the service filter would look
    //    plausible and be wrong.
    const unknown = await cached.aggregate({
      filters: {
        since: probeSince,
        until: probeUntil,
        attributes: {},
        service: `${probeService}-consistency-probe`,
      },
      bucket: "1d",
    });
    assert.equal(
      unknown.reduce((sum, row) => sum + row.count, 0),
      0,
      "an unknown service must sum to exactly 0, or the caller abandons the fast path",
    );
    assert.deepEqual(unknown, [], "an unknown service must return an empty bucket list");

    // 3. The dashboard shape: no service filter at all, minute buckets, an
    //    hour-wide window ending in the future. Its left edge lands in empty
    //    time, which is the case the counters answer without any SQL.
    const perfFilters = {
      since: new Date(spanEndMs - 3_600 * SECOND_MS).toISOString(),
      until: new Date(spanEndMs + 60 * SECOND_MS).toISOString(),
      attributes: {},
    };
    const perf = await cached.aggregate({ filters: perfFilters, bucket: "1m" });
    assert.deepEqual(
      perf,
      await direct.aggregate({ filters: perfFilters, bucket: "1m" }),
      "the unfiltered hour-wide window must match the SQL path",
    );
    assert.equal(
      perf.reduce((sum, row) => sum + row.count, 0),
      SEEDED.length + STREAMED.length,
      "the unfiltered window must see every seeded row",
    );
  });
});

test("aggregate cache: a covered window with empty edges never reaches PostgreSQL", async () => {
  await withFixture(async ({ cached, resetQueryCount, queryCount }) => {
    const spanEndMs = baseMs + SPAN_SECONDS * SECOND_MS;

    // Both bounds on exact second boundaries: there are no partial edges, so
    // there is nothing for SQL to answer and the statement count must be zero.
    resetQueryCount();
    const aligned = await cached.aggregate({
      filters: { since: new Date(baseMs).toISOString(), until: new Date(spanEndMs).toISOString(), attributes: {} },
      bucket: "1m",
    });
    assert.equal(queryCount(), 0, "a fully covered, second-aligned window must issue no statements");
    assert.equal(
      aligned.reduce((sum, row) => sum + row.count, 0),
      SEEDED.length + STREAMED.length,
      "the aligned window must still count every row",
    );

    // An unaligned bound whose second holds rows does need SQL — but exactly
    // one statement for both edges, over at most one second each, rather than
    // the partial minutes the rollup path has to scan.
    resetQueryCount();
    await cached.aggregate({
      filters: {
        since: new Date(baseMs + 137).toISOString(),
        until: new Date(spanEndMs - SECOND_MS + 500).toISOString(),
        attributes: {},
      },
      bucket: "1m",
    });
    assert.equal(queryCount(), 1, "both partial edges must be answered by a single statement");

    // A window reaching back before hydration is not covered and must decline
    // rather than answer from a cache that never held those rows.
    resetQueryCount();
    await cached.aggregate({
      filters: {
        since: new Date(baseMs - 4 * 60 * 60 * SECOND_MS).toISOString(),
        until: new Date(spanEndMs).toISOString(),
        attributes: {},
      },
      bucket: "1h",
    });
    assert.ok(queryCount() > 0, "a window older than the cache window must fall through to SQL");
  });
});
