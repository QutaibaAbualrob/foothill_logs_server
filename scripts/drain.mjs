/**
 * Drain harness.
 *
 * Walks GET /logs by cursor from the newest row to the true end of the filtered
 * set, under a deadline, and reports pages/second, rows/second and per-page
 * latency percentiles.
 *
 * This is both a performance measurement and a correctness gate. The load
 * generator verifies freshness by walking pagination to the end inside a fixed
 * window, and that walk is sequential — page N+1 cannot start until page N
 * returns — so completion is governed by:
 *
 *   records drainable = window (s) x pages/second x page size (rows)
 *
 * The correctness half matters just as much: a walk that ends early while
 * reporting a clean `next_cursor: null` looks identical to a successful walk
 * unless the rows actually returned are counted and compared against a trusted
 * total. EXPECT_TOTAL turns that comparison into a hard failure.
 *
 * Usage:
 *   node scripts/drain.mjs
 *   BASE_URL=http://127.0.0.1:8081 PAGE_SIZE=1000 EXPECT_TOTAL=599605 node scripts/drain.mjs
 */

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:8080";
const pageSize = Number(process.env.PAGE_SIZE ?? 1000);
const deadlineSeconds = Number(process.env.DEADLINE_SECONDS ?? 30);
const maxPages = Number(process.env.MAX_PAGES ?? 100000);
const expectTotal = process.env.EXPECT_TOTAL === undefined ? null : Number(process.env.EXPECT_TOTAL);
// Filters are passed straight through so the same harness can measure the
// unfiltered walk, a service-filtered walk, or a hot-attribute walk.
const filters = process.env.FILTERS ?? "";

const query = new URLSearchParams(filters);
query.set("limit", String(pageSize));

const latencies = [];
const seen = new Set();
let duplicates = 0;
let pages = 0;
let rows = 0;
let cursor = null;
let reachedEnd = false;
let previousKey = null;
let orderViolations = 0;

const startedAt = performance.now();
const deadlineAt = startedAt + deadlineSeconds * 1000;

while (pages < maxPages) {
  if (cursor === null && pages > 0) break;
  if (cursor !== null) query.set("cursor", cursor);

  const pageStarted = performance.now();
  const response = await fetch(`${baseUrl}/logs?${query.toString()}`);
  if (!response.ok) {
    console.error(`page ${pages} failed with HTTP ${response.status}: ${await response.text()}`);
    process.exit(1);
  }
  const body = await response.json();
  latencies.push(performance.now() - pageStarted);

  for (const log of body.logs) {
    if (seen.has(log.id)) duplicates += 1;
    seen.add(log.id);
    // Ordering must be strictly descending on (timestamp, id) with id compared
    // as an integer. A lexicographic id comparison passes a naive eyeball check
    // and still corrupts the walk at every digit-length boundary.
    const key = { timestamp: log.timestamp, id: BigInt(log.id) };
    if (previousKey !== null) {
      const ordered =
        previousKey.timestamp > key.timestamp ||
        (previousKey.timestamp === key.timestamp && previousKey.id > key.id);
      if (!ordered) orderViolations += 1;
    }
    previousKey = key;
  }

  rows += body.logs.length;
  pages += 1;
  cursor = body.next_cursor;

  if (cursor === null) {
    reachedEnd = true;
    break;
  }
  if (performance.now() > deadlineAt) break;
}

const elapsedSeconds = (performance.now() - startedAt) / 1000;

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return Number(
    ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)].toFixed(3),
  );
}

const result = {
  pageSize,
  pages,
  rows,
  uniqueRows: seen.size,
  duplicates,
  orderViolations,
  reachedEnd,
  withinDeadline: elapsedSeconds <= deadlineSeconds,
  elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
  pagesPerSecond: Number((pages / elapsedSeconds).toFixed(1)),
  rowsPerSecond: Number((rows / elapsedSeconds).toFixed(0)),
  pageMs: {
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
  },
};
if (expectTotal !== null) {
  result.expectedRows = expectTotal;
  result.rowsMatchExpected = seen.size === expectTotal;
}

console.log(JSON.stringify(result, null, 2));

const failures = [];
if (duplicates > 0) failures.push(`${duplicates} duplicate rows`);
if (orderViolations > 0) failures.push(`${orderViolations} ordering violations`);
if (!reachedEnd) failures.push("walk did not reach the true end");
if (expectTotal !== null && seen.size !== expectTotal) {
  failures.push(`walked ${seen.size} unique rows, expected ${expectTotal}`);
}
if (failures.length > 0) {
  console.error(`drain FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
