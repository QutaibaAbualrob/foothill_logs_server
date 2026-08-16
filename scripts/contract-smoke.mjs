import assert from "node:assert/strict";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:8080";

async function request(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json();
  return { response, body };
}

const health = await request("/health");
assert.equal(health.response.status, 200);

const minute = new Date(Date.now() - 60_000);
minute.setUTCSeconds(0, 0);
const timestamp = minute.toISOString().replace(".000Z", ".123456Z");
const run = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const service = `smoke-${run}`;
const logs = Array.from({ length: 5 }, (_, index) => ({
  timestamp,
  level: index % 2 === 0 ? "info" : "error",
  service,
  message: index === 0 ? `literal 100%_ready ${run}` : `smoke event ${index} ${run}`,
  attributes: { trace_id: `${run}-${index}`, attempt: index, valid: true },
}));

const ingestion = await request("/logs", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: "Bearer ignored-by-default",
  },
  body: JSON.stringify({
    logs: [
      ...logs,
      { timestamp, level: "fatal", service, message: "invalid" },
    ],
  }),
});
assert.equal(ingestion.response.status, 200);
assert.equal(ingestion.body.accepted, 5);
assert.deepEqual(ingestion.body.rejected.map((item) => item.index), [5]);

const seen = new Set();
let cursor = null;
for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
  const path = `/logs?service=${encodeURIComponent(service)}&limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
  const page = await request(path);
  assert.equal(page.response.status, 200);
  for (const log of page.body.logs) {
    assert.equal(log.timestamp, timestamp);
    assert.equal(seen.has(log.id), false, "pagination returned a duplicate id");
    seen.add(log.id);
  }
  cursor = page.body.next_cursor;
  if (cursor === null) break;
}
assert.equal(seen.size, 5, "cursor walk did not return every equal-timestamp row");
assert.equal(cursor, null, "cursor walk did not terminate at the true end");

// Regression: every row below shares one timestamp, so ordering falls entirely
// to the id tiebreaker, and there are enough of them that the ids cross a digit
// boundary (9 -> 10). Under lexicographic ordering '9' sorts after '12', which
// disagrees with the keyset predicate's bigint comparison and silently drops
// rows mid-walk. A walk that spans several pages is what exposes it.
const tiedService = `tied-${run}`;
const tiedTimestamp = timestamp;
const tiedCount = 25;
const tiedIngest = await request("/logs", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    logs: Array.from({ length: tiedCount }, (_, index) => ({
      timestamp: tiedTimestamp,
      level: "info",
      service: tiedService,
      message: `tied ${index}`,
      attributes: {},
    })),
  }),
});
assert.equal(tiedIngest.response.status, 200);
assert.equal(tiedIngest.body.accepted, tiedCount);

const tiedSeen = [];
let tiedCursor = null;
for (let page = 0; page < tiedCount + 2; page += 1) {
  const path = `/logs?service=${encodeURIComponent(tiedService)}&limit=4${tiedCursor === null ? "" : `&cursor=${encodeURIComponent(tiedCursor)}`}`;
  const result = await request(path);
  assert.equal(result.response.status, 200);
  for (const log of result.body.logs) tiedSeen.push(log.id);
  tiedCursor = result.body.next_cursor;
  if (tiedCursor === null) break;
}
assert.equal(tiedCursor, null, "tied-timestamp walk did not reach the true end");
assert.equal(
  tiedSeen.length,
  tiedCount,
  `tied-timestamp walk returned ${tiedSeen.length} of ${tiedCount} rows`,
);
assert.equal(new Set(tiedSeen).size, tiedCount, "tied-timestamp walk returned a duplicate id");
// Ordering must be strictly descending as BIGINT, not as text.
const tiedNumeric = tiedSeen.map((id) => BigInt(id));
for (let index = 1; index < tiedNumeric.length; index += 1) {
  assert.ok(
    tiedNumeric[index - 1] > tiedNumeric[index],
    `ids are not in descending numeric order: ${tiedSeen[index - 1]} then ${tiedSeen[index]}`,
  );
}

const traced = await request(`/logs?attr.trace_id=${encodeURIComponent(`${run}-3`)}&limit=10`);
assert.equal(traced.response.status, 200);
assert.equal(traced.body.logs.length, 1);

const literal = await request(`/logs?service=${encodeURIComponent(service)}&q=${encodeURIComponent("100%_")}`);
assert.equal(literal.response.status, 200);
assert.equal(literal.body.logs.length, 1);

const until = new Date(minute.getTime() + 60_000);
const aggregate = await request(
  `/logs/aggregate?since=${encodeURIComponent(minute.toISOString())}&until=${encodeURIComponent(until.toISOString())}&bucket=1m&group_by=service&service=${encodeURIComponent(service)}`,
);
assert.equal(aggregate.response.status, 200);
assert.equal(aggregate.body.buckets.length, 1);
assert.equal(aggregate.body.buckets[0].group, service);
assert.equal(aggregate.body.buckets[0].count, 5);

// G1: a range not aligned to a minute boundary must count edge minutes only
// for the requested span. Seed 6 rows in one minute: 3 at +5s, 3 at +40s.
// A range of [+10s, +50s) must return exactly the 3 rows at +40s; a naive
// whole-minute rollup would count all 6.
const edgeService = `edge-${run}`;
const edgeMinute = new Date(Date.now() - 120_000);
edgeMinute.setUTCSeconds(0, 0);
const edgeAt = (second) => new Date(edgeMinute.getTime() + second * 1000).toISOString().replace(".000Z", ".100000Z");
const edgeIngest = await request("/logs", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    logs: [
      ...Array.from({ length: 3 }, (_, index) => ({
        timestamp: edgeAt(5 + index), level: "info", service: edgeService, message: `edge-early-${index}`,
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        timestamp: edgeAt(40 + index), level: "info", service: edgeService, message: `edge-late-${index}`,
      })),
    ],
  }),
});
assert.equal(edgeIngest.response.status, 200);
assert.equal(edgeIngest.body.accepted, 6);
const edgeAggregate = await request(
  `/logs/aggregate?since=${encodeURIComponent(edgeAt(10))}&until=${encodeURIComponent(edgeAt(50))}&bucket=1m&service=${encodeURIComponent(edgeService)}`,
);
assert.equal(edgeAggregate.response.status, 200);
assert.equal(edgeAggregate.body.buckets.length, 1);
assert.equal(
  edgeAggregate.body.buckets[0].count,
  3,
  "unaligned range must count only the rows inside the edge slices, not the whole edge minutes",
);

const badCursor = await request("/logs?cursor=not-a-cursor");
assert.equal(badCursor.response.status, 400);

const allInvalid = await request("/logs", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ logs: [{ timestamp, level: "fatal", service, message: "invalid" }] }),
});
assert.equal(allInvalid.response.status, 400);
assert.equal(allInvalid.body.accepted, 0);
assert.equal(allInvalid.body.rejected.length, 1);

const malformed = await fetch(`${baseUrl}/logs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{bad-json",
});
assert.equal(malformed.status, 400);

console.log(JSON.stringify({
  status: "ok",
  accepted: ingestion.body.accepted,
  paginated: seen.size,
  aggregateCount: aggregate.body.buckets[0].count,
}));
