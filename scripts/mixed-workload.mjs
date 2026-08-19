/**
 * Mixed-workload harness — reads while writes are happening.
 *
 * Every other harness in this repo measures one thing at a time:
 * `benchmark.mjs` ingests, `drain.mjs` walks pages against a table nobody is
 * writing to. The service exists to serve queries *during* ingestion, and that
 * combination has never been measured. The two conditions are not close — a
 * read path that is application-limited at rest competes for the same 0.5-CPU
 * cap as the write path once both run together.
 *
 * Two things here differ from `benchmark.mjs` on purpose.
 *
 * 1. **The load is open-loop.** `benchmark.mjs` runs a fixed pool of workers
 *    that each send, await, and send again. That is closed-loop: when the
 *    server slows, the client automatically sends less, so offered load falls
 *    to whatever the server can absorb and queues never build. A client
 *    population in front of a real log service does not do that — it keeps
 *    producing at its own rate regardless. This harness dispatches on a clock
 *    to hit TARGET_LOGS_PER_SECOND whether or not earlier requests have come
 *    back, which is the only way backlog, latency blow-out and the gap between
 *    "accepted" and "visible" can appear at all.
 *
 * 2. **Acceptance is not visibility.** A 200 from POST /logs means the batch
 *    was durably queued, not that a reader can see it. This harness records
 *    both: `accepted` from the ingest responses, and `visibleWithinWindow` from
 *    a cursor walk taken after the load stops. Their difference is the number
 *    a client experiences as missing data.
 *
 * Usage:
 *   node scripts/mixed-workload.mjs
 *   DURATION_SECONDS=120 TARGET_LOGS_PER_SECOND=15000 BATCH_SIZE=33 \
 *     RESULT_PATH=bench/raw/mixed.json node scripts/mixed-workload.mjs
 *
 * Run it against a clean volume, one stack at a time, and pair it with
 * scripts/capture-resources.mjs for the CPU and RSS columns.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:8080";
const durationSeconds = Number(process.env.DURATION_SECONDS ?? 120);
const targetLogsPerSecond = Number(process.env.TARGET_LOGS_PER_SECOND ?? 15_000);
const batchSize = Number(process.env.BATCH_SIZE ?? 33);
const pageSize = Number(process.env.PAGE_SIZE ?? 1000);
const visibilityWindowSeconds = Number(process.env.VISIBILITY_WINDOW_SECONDS ?? 30);
const aggregateIntervalMs = Number(process.env.AGGREGATE_INTERVAL_MS ?? 1000);
// A ceiling on outstanding requests. Without one, an unresponsive server turns
// an open-loop client into an unbounded memory leak in the harness itself, and
// the harness becomes the bottleneck under measurement. Requests that would
// exceed it are counted as `shed` rather than sent: shedding is a result, not
// an error, and it means the offered rate was never actually delivered.
const maxInFlight = Number(process.env.MAX_IN_FLIGHT ?? 512);
// Filters passed straight through, so the same harness can measure the
// unfiltered walk or the hot-attribute path (which has no coverage at all
// while HOT_ATTRIBUTE_KEYS is empty in the shipped compose file).
const drainFilters = process.env.DRAIN_FILTERS ?? "";
// Whether writes keep flowing while visibility is measured. They must, by
// default: a reader catching up on a table nobody is writing to has the whole
// CPU to itself and will always look fine. Measuring the catch-up window
// against a quiesced server reported 100% visible on a run whose page rate
// under load was 1.4 pages/s -- the quiet is what made it pass.
const visibilityUnderLoad = (process.env.VISIBILITY_UNDER_LOAD ?? "true") !== "false";

const resultPath = process.env.RESULT_PATH;
const absoluteResultPath = resultPath === undefined ? undefined : resolve(resultPath);
if (absoluteResultPath !== undefined) {
  mkdirSync(dirname(absoluteResultPath), { recursive: true });
  if (existsSync(absoluteResultPath)) {
    throw new Error(`RESULT_PATH already exists; choose a new path: ${absoluteResultPath}`);
  }
}
for (const [name, value] of Object.entries({
  durationSeconds,
  targetLogsPerSecond,
  batchSize,
  pageSize,
  visibilityWindowSeconds,
  maxInFlight,
})) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
}

const ingestLatencies = [];
const drainPageLatencies = [];
const aggregateLatencies = [];
const series = [];

let accepted = 0;
let rejected = 0;
let ingestErrors = 0;
let readErrors = 0;
let requestsSent = 0;
let shed = 0;
let inFlight = 0;
let sequence = 0;
let drainPages = 0;
let drainRows = 0;
let drainRestarts = 0;
const batches = [];

const SERVICES = ["checkout", "auth", "catalog", "payments"];
const LEVELS = ["debug", "info", "warn", "error"];

function body() {
  const request = sequence++;
  const timestampMs = Date.now();
  const timestamp = new Date(timestampMs).toISOString();
  const payload = JSON.stringify({
    logs: Array.from({ length: batchSize }, (_, index) => ({
      timestamp,
      level: LEVELS[(request + index) % LEVELS.length],
      service: SERVICES[(request + index) % SERVICES.length],
      message: `mixed workload event ${request}-${index}`,
      attributes: { trace_id: `mixed-${request}-${index}`, region: "eu-west", retry: index % 3 },
    })),
  });
  return { payload, timestampMs };
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return Number(
    ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)].toFixed(3),
  );
}

function send() {
  inFlight += 1;
  requestsSent += 1;
  const started = performance.now();
  const { payload, timestampMs } = body();
  return fetch(`${baseUrl}/logs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
  })
    .then(async (response) => {
      ingestLatencies.push(performance.now() - started);
      if (response.status !== 200) {
        ingestErrors += 1;
        await response.arrayBuffer();
        return;
      }
      const result = await response.json();
      const count = result.accepted ?? 0;
      accepted += count;
      // Kept against the batch's own timestamp so the visibility denominator can
      // be restricted to exactly the rows the bounded walk was allowed to see.
      batches.push({ timestampMs, accepted: count });
      rejected += Array.isArray(result.rejected) ? result.rejected.length : (result.rejected ?? 0);
    })
    .catch(() => {
      ingestErrors += 1;
    })
    .finally(() => {
      inFlight -= 1;
    });
}

/**
 * Dispatches batches against a wall clock rather than against completions, so
 * the offered rate stays at the target even while the server is slow. Anything
 * the in-flight ceiling prevents is recorded as shed.
 */
async function offerLoad(endAt) {
  const batchesPerSecond = targetLogsPerSecond / batchSize;
  const intervalMs = 1000 / batchesPerSecond;
  const startedAt = performance.now();
  let dispatched = 0;
  const pending = new Set();

  while (performance.now() < endAt) {
    const elapsedMs = performance.now() - startedAt;
    const due = Math.floor(elapsedMs / intervalMs) - dispatched;
    for (let index = 0; index < due; index += 1) {
      if (inFlight >= maxInFlight) {
        shed += 1;
      } else {
        const promise = send();
        pending.add(promise);
        void promise.finally(() => pending.delete(promise));
      }
      dispatched += 1;
    }
    await new Promise((r) => setTimeout(r, 2));
  }
  await Promise.allSettled([...pending]);
}

/**
 * Walks pages continuously for the whole run. On reaching the end it restarts
 * from the newest row, because the table is growing underneath it — the point
 * is the sustained page rate under write pressure, not a single complete walk.
 */
async function drainUnderLoad(endAt) {
  const query = new URLSearchParams(drainFilters);
  query.set("limit", String(pageSize));
  let cursor = null;

  while (performance.now() < endAt) {
    if (cursor === null) query.delete("cursor");
    else query.set("cursor", cursor);
    const started = performance.now();
    try {
      const response = await fetch(`${baseUrl}/logs?${query.toString()}`);
      if (!response.ok) {
        readErrors += 1;
        await response.arrayBuffer();
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      const page = await response.json();
      drainPageLatencies.push(performance.now() - started);
      drainPages += 1;
      drainRows += page.logs?.length ?? 0;
      cursor = page.next_cursor ?? null;
      if (cursor === null) drainRestarts += 1;
    } catch {
      readErrors += 1;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

async function aggregateUnderLoad(endAt) {
  while (performance.now() < endAt) {
    const until = new Date();
    until.setUTCSeconds(0, 0);
    const since = new Date(until.getTime() - 60 * 60 * 1000);
    const started = performance.now();
    try {
      const response = await fetch(
        `${baseUrl}/logs/aggregate?since=${encodeURIComponent(since.toISOString())}` +
          `&until=${encodeURIComponent(until.toISOString())}&bucket=1m&group_by=service`,
      );
      aggregateLatencies.push(performance.now() - started);
      if (!response.ok) readErrors += 1;
      await response.arrayBuffer();
    } catch {
      readErrors += 1;
    }
    await new Promise((r) => setTimeout(r, aggregateIntervalMs));
  }
}

/** Five-second buckets, so a sawtooth is visible rather than averaged away. */
async function sampleSeries(endAt) {
  let lastAccepted = 0;
  let lastPages = 0;
  while (performance.now() < endAt) {
    await new Promise((r) => setTimeout(r, 5000));
    series.push({
      atSeconds: series.length * 5 + 5,
      acceptedLogs: accepted - lastAccepted,
      logsPerSecond: Math.round((accepted - lastAccepted) / 5),
      drainPages: drainPages - lastPages,
      inFlight,
    });
    lastAccepted = accepted;
    lastPages = drainPages;
  }
}

/**
 * After the writes stop, walk from the newest row and count what a reader can
 * actually see inside a bounded window, counting only rows this run wrote. This is the number that matters to a
 * client: rows acknowledged but not yet visible are, from outside, missing.
 */
async function measureVisibility(sinceIso, untilIso, deadline) {
  const query = new URLSearchParams(drainFilters);
  query.set("limit", String(pageSize));
  // Both bounds matter. `since` excludes rows left by an earlier run; `until`
  // excludes rows written *during* this walk, which would otherwise be counted
  // in the numerator while the denominator stayed frozen -- that is how an
  // earlier version reported 100.1% visible. builder.ts applies [since, until),
  // and the denominator below uses the same half-open window.
  query.set("until", untilIso);
  // Scoped to rows this run produced. Without it the walk counts whatever was
  // already in the table and the ratio becomes meaningless -- a validation run
  // against a table left over from the failure drill reported 303,000 visible
  // against 59,994 accepted. `since` is an ordinary supported filter and the
  // rows carry their send time, so this needs no marker attribute.
  query.set("since", sinceIso);
  let cursor = null;
  let visible = 0;
  let pages = 0;
  let reachedEnd = false;

  while (performance.now() < deadline) {
    if (cursor !== null) query.set("cursor", cursor);
    try {
      const response = await fetch(`${baseUrl}/logs?${query.toString()}`);
      if (!response.ok) {
        readErrors += 1;
        break;
      }
      const page = await response.json();
      visible += page.logs?.length ?? 0;
      pages += 1;
      cursor = page.next_cursor ?? null;
      if (cursor === null) {
        reachedEnd = true;
        break;
      }
    } catch {
      readErrors += 1;
      break;
    }
  }
  const elapsed = visibilityWindowSeconds * 1000 - (deadline - performance.now());
  return {
    visible,
    pages,
    reachedEnd,
    // "the reader ran out of clock" and "there was nothing more to read" are
    // different outcomes and must not both read as a bare percentage.
    limitedBy: reachedEnd ? "data" : "window",
    elapsedSeconds: Number((elapsed / 1000).toFixed(3)),
  };
}

const startedAtIso = new Date().toISOString();
const startedAt = performance.now();
const endAt = startedAt + durationSeconds * 1000;
const visibilityEndAt = endAt + visibilityWindowSeconds * 1000;

let cutoffMs = 0;
let visibility;

await Promise.all([
  // Load continues through the visibility window unless explicitly disabled,
  // so the catch-up is measured against a server still under write pressure.
  offerLoad(visibilityUnderLoad ? visibilityEndAt : endAt),
  drainUnderLoad(endAt),
  aggregateUnderLoad(endAt),
  sampleSeries(endAt),
  (async () => {
    while (performance.now() < endAt) await new Promise((r) => setTimeout(r, 25));
    // Rows acknowledged before the walk begins are the ones a reader should be
    // able to find; anything accepted during the walk is a moving target.
    cutoffMs = Date.now();
    visibility = await measureVisibility(startedAtIso, new Date(cutoffMs).toISOString(), visibilityEndAt);
  })(),
]);

const loadElapsedSeconds = (performance.now() - startedAt) / 1000;
// Computed after every in-flight request has settled, so a batch dispatched
// just before the cutoff is counted on both sides rather than only in the walk.
const startMs = Date.parse(startedAtIso);
const acceptedInWindow = batches
  .filter((b) => b.timestampMs >= startMs && b.timestampMs < cutoffMs)
  .reduce((total, b) => total + b.accepted, 0);

const offeredLogs = (requestsSent + shed) * batchSize;
const result = {
  startedAt: startedAtIso,
  endedAt: new Date().toISOString(),
  baseUrl,
  configuredDurationSeconds: durationSeconds,
  targetLogsPerSecond,
  batchSize,
  pageSize,
  drainFilters,
  elapsedSeconds: Number(loadElapsedSeconds.toFixed(3)),

  ingest: {
    offeredLogs,
    requestsSent,
    shedRequests: shed,
    accepted,
    rejected,
    errors: ingestErrors,
    logsPerSecond: Number((accepted / loadElapsedSeconds).toFixed(1)),
    // Below 1.0 means the client could not even offer the target rate, so the
    // measured throughput is a floor set by the harness, not by the service.
    offeredRateRatio: Number((offeredLogs / (targetLogsPerSecond * loadElapsedSeconds)).toFixed(3)),
    latencyMs: {
      p50: percentile(ingestLatencies, 0.5),
      p95: percentile(ingestLatencies, 0.95),
      p99: percentile(ingestLatencies, 0.99),
    },
  },

  // The headline: page rate while writes are in progress.
  drainUnderLoad: {
    pages: drainPages,
    rows: drainRows,
    restarts: drainRestarts,
    pagesPerSecond: Number((drainPages / loadElapsedSeconds).toFixed(2)),
    rowsPerSecond: Number((drainRows / loadElapsedSeconds).toFixed(0)),
    pageMs: {
      p50: percentile(drainPageLatencies, 0.5),
      p95: percentile(drainPageLatencies, 0.95),
      p99: percentile(drainPageLatencies, 0.99),
    },
  },

  aggregateUnderLoad: {
    samples: aggregateLatencies.length,
    p50: percentile(aggregateLatencies, 0.5),
    p95: percentile(aggregateLatencies, 0.95),
    p99: percentile(aggregateLatencies, 0.99),
  },

  visibility: {
    windowSeconds: visibilityWindowSeconds,
    underLoad: visibilityUnderLoad,
    scopedSince: startedAtIso,
    scopedUntil: new Date(cutoffMs).toISOString(),
    limitedBy: visibility.limitedBy,
    acceptedLogs: acceptedInWindow,
    visibleLogs: visibility.visible,
    missingLogs: Math.max(0, acceptedInWindow - visibility.visible),
    visibleRatio:
      acceptedInWindow === 0 ? null : Number((visibility.visible / acceptedInWindow).toFixed(4)),
    pagesWalked: visibility.pages,
    reachedEnd: visibility.reachedEnd,
    elapsedSeconds: visibility.elapsedSeconds,
  },

  readErrors,
  series,
};

const output = `${JSON.stringify(result, null, 2)}\n`;
if (absoluteResultPath !== undefined) {
  writeFileSync(absoluteResultPath, output, { flag: "wx" });
  console.error(`result: ${absoluteResultPath}`);
}
process.stdout.write(output);

// A run with ingest errors, read errors, or shed requests is not a clean
// measurement of the service; say so in the exit code rather than letting a
// caller record the number as if it were.
if (ingestErrors > 0 || readErrors > 0 || shed > 0) process.exitCode = 1;
