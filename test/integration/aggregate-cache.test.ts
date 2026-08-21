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

// The millisecond fringe layer. A window whose upper bound comes from the clock
// puts its fringe inside the *current* second, which under load is never empty
// — so the "boundary second is empty" shortcut never fires and every request
// used to reach SQL. These assert that it no longer does, that a filtered query
// still declines rather than answering from a total, and that a fringe reaching
// back past the millisecond window declines too.
const MS_SERVICE = "t09_ms_fringe";
const MS_OTHER = "t09_ms_other";

test("aggregate cache: a live sub-second fringe is answered without SQL", async () => {
  process.env.HOT_ATTRIBUTE_KEYS = "";
  const config = loadConfig();
  const pool = new Pool({ connectionString: databaseUrl });
  let client: PoolClient | undefined;
  try {
    await migrate(pool, config.retentionDays, []);
    client = await pool.connect();
    const writes = new PgLogWriteRepository(pool, config.syncCommit);

    const counters = new AggregateCounters();
    await counters.hydrate(pool);
    assert.equal(counters.enabled, true, "hydration must leave the cache usable");

    // Rows land after hydration, so they carry millisecond resolution. Several
    // share a millisecond and several share a second, which is what a fringe
    // has to add up correctly.
    const t0 = Date.now();
    // Anchored on a real second boundary so the window's geometry is fixed
    // rather than a function of Date.now() % 1000, and one row on every
    // millisecond so any chosen bound has a row sitting exactly on it.
    //
    // The lower fringe below reaches BACK from the anchor by FRINGE_BACK_MS,
    // and rows cannot start any earlier than `t0`: the millisecond layer only
    // retains what it saw after hydration, so backdating the fixture would put
    // the row outside the layer rather than inside it. The anchor therefore has
    // to sit at least that far above `t0`, which is what the `+ FRINGE_BACK_MS`
    // guarantees — `anchor >= t0 + FRINGE_BACK_MS`, hence
    // `anchor - FRINGE_BACK_MS >= t0`, for every possible `Date.now() % 1000`.
    const FRINGE_BACK_MS = 300;
    const anchor = Math.ceil((t0 + FRINGE_BACK_MS) / SECOND_MS) * SECOND_MS;
    const recent: NormalizedLog[] = [];
    for (let offset = 0; offset <= anchor - t0 + 1_400; offset += 1) {
      for (let repeat = 0; repeat < 2; repeat += 1) {
        const timestamp = new Date(t0 + offset).toISOString();
        const service = offset % 3 === 0 ? MS_SERVICE : MS_OTHER;
        recent.push({
          timestamp,
          level: "info",
          service,
          message: `ms fringe ${timestamp}`,
          attributes: {},
          attributesJson: "{}",
          estimatedBytes: 96,
        });
      }
    }
    await writes.insertCommitted(recent);
    counters.add(recent);
    assert.ok(counters.recentSize > 0, "the millisecond layer must hold slots for recent rows");

    let queries = 0;
    const counted = countingPool(pool, () => {
      queries += 1;
    });
    const codec = new CursorCodec("test");
    const cached = new PgLogQueryRepository(counted, codec, [], counters);
    const direct = new PgLogQueryRepository(pool, codec, []);

    // A clock-derived upper bound, landing mid-second inside live data — the
    // shape that cost one statement per aggregate on every request.
    //
    // A row sits on this instant and must be EXCLUDED (`timestamp < until`). A
    // bound chosen between rows cannot tell a half-open range from a closed
    // one, and an off-by-one would count rows the SQL path does not.
    const untilMs = anchor + 1_135;
    const since = new Date(untilMs - 3_600_000).toISOString();
    const until = new Date(untilMs).toISOString();

    queries = 0;
    const unfiltered = await cached.aggregate({ filters: { since, until, attributes: {} }, bucket: "1m" });
    const statements = queries;
    assert.deepEqual(
      unfiltered,
      await direct.aggregate({ filters: { since, until, attributes: {} }, bucket: "1m" }),
      "a clock-derived window must agree with the SQL path exactly",
    );
    assert.equal(statements, 0, "a live sub-second fringe must be answered from memory, with no statement");
    assert.equal(
      unfiltered.reduce((sum, row) => sum + row.count, 0),
      recent.filter((entry) => Date.parse(entry.timestamp) < untilMs).length,
      "the fringe total must count every row strictly before the bound",
    );

    assert.ok(
      recent.some((entry) => Date.parse(entry.timestamp) === untilMs),
      "the fixture must place rows exactly on the bound, or this asserts nothing",
    );

    // Both fringes live: `since` also lands mid-second inside the data, and on
    // a row, which must be INCLUDED (`timestamp >= since`). The two halves of a
    // half-open range fail in opposite directions, so both need a row on them.
    const bothSinceMs = anchor - FRINGE_BACK_MS;
    assert.ok(
      recent.some((entry) => Date.parse(entry.timestamp) === bothSinceMs),
      "the fixture must place rows exactly on the lower bound too",
    );
    const bothFilters = {
      since: new Date(bothSinceMs).toISOString(),
      until: new Date(untilMs).toISOString(),
      attributes: {},
    };
    queries = 0;
    const both = await cached.aggregate({ filters: bothFilters, bucket: "1m" });
    const bothStatements = queries;
    assert.deepEqual(
      both,
      await direct.aggregate({ filters: bothFilters, bucket: "1m" }),
      "a window with two live fringes must agree with the SQL path exactly",
    );
    assert.equal(
      both.reduce((sum, row) => sum + row.count, 0),
      recent.filter((e) => {
        const ms = Date.parse(e.timestamp);
        return ms >= bothSinceMs && ms < untilMs;
      }).length,
      "a half-open range must include the row on `since` and exclude the row on `until`",
    );
    assert.equal(bothStatements, 0, "two live fringes must both be answered from memory");

    // A window that fits entirely inside one populated second. There is no
    // whole-second interior AND the two fringes would overrun each other —
    // [since, next boundary) reaches past `until`, and [previous boundary,
    // until) reaches back before `since` — so this must decline outright
    // rather than add two overlapping partial sums.
    const innerFilters = {
      since: new Date(anchor + 200).toISOString(),
      until: new Date(anchor + 700).toISOString(),
      attributes: {},
    };
    const inner = await cached.aggregate({ filters: innerFilters, bucket: "1m" });
    assert.deepEqual(
      inner,
      await direct.aggregate({ filters: innerFilters, bucket: "1m" }),
      "a sub-second window must agree with the SQL path exactly",
    );
    assert.equal(
      inner.reduce((sum, row) => sum + row.count, 0),
      recent.filter((e) => {
        const ms = Date.parse(e.timestamp);
        return ms >= anchor + 200 && ms < anchor + 700;
      }).length,
      "a sub-second window must count each row once, not twice",
    );

    // The same window with a service filter. The millisecond layer is
    // total-only, so this must decline to SQL rather than answer from a total.
    queries = 0;
    const filters = { since, until, attributes: {}, service: MS_SERVICE };
    const filtered = await cached.aggregate({ filters, bucket: "1m" });
    const filteredStatements = queries;
    assert.deepEqual(
      filtered,
      await direct.aggregate({ filters, bucket: "1m" }),
      "a filtered clock-derived window must still agree with the SQL path",
    );
    assert.equal(filteredStatements, 1, "a filtered live fringe must decline to exactly one statement");
    assert.equal(
      filtered.reduce((sum, row) => sum + row.count, 0),
      recent.filter((e) => e.service === MS_SERVICE && Date.parse(e.timestamp) < untilMs).length,
      "the filtered total must count only that service",
    );
    assert.ok(
      filtered.reduce((sum, row) => sum + row.count, 0) <
        unfiltered.reduce((sum, row) => sum + row.count, 0),
      "the filtered total must be strictly smaller, or the filter was ignored",
    );
  } finally {
    for (const service of [MS_SERVICE, MS_OTHER]) {
      await client?.query("DELETE FROM logs WHERE service = $1", [service]).catch(() => undefined);
      await client?.query("DELETE FROM logs_agg_1m WHERE service = $1", [service]).catch(() => undefined);
    }
    client?.release();
    await pool.end();
  }
});

test("aggregate cache: a fringe older than the millisecond window declines to SQL", async () => {
  await withFixture(async ({ cached, direct, resetQueryCount, queryCount }) => {
    // The seeded span is 45 minutes old, far outside the millisecond window,
    // and hydration cannot reconstruct sub-second detail from a per-second
    // GROUP BY. Answering this from the millisecond layer would return a
    // partial sum; the only correct move is to decline.
    const untilMs = baseMs + 90 * SECOND_MS + 137;
    const since = new Date(baseMs).toISOString();
    const until = new Date(untilMs).toISOString();
    const filters = { since, until, attributes: {} };

    resetQueryCount();
    const fromCache = await cached.aggregate({ filters, bucket: "1m" });
    assert.ok(
      queryCount() > 0,
      "a fringe predating the millisecond window must fall through to SQL, not answer from a partial sum",
    );
    assert.deepEqual(
      fromCache,
      await direct.aggregate({ filters, bucket: "1m" }),
      "declining must still produce the exact SQL answer",
    );
  });
});
