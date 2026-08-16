/**
 * G2 reliability matrix.
 *
 * Every row asserts a status code and that the error body has the required
 * shape. The point is not that bad input is rejected — it is that bad input is
 * rejected with a 4xx rather than crashing the process or leaking a 500. A 500
 * here means a client string reached a code path that could not handle it.
 *
 * The PostgreSQL-stopped and SIGTERM rows need container orchestration and are
 * driven by scripts/failure-drill.sh instead.
 *
 * Usage: BASE_URL=http://127.0.0.1:8081 node scripts/reliability-check.mjs
 */

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:8080";

let passed = 0;
const failures = [];

async function expectStatus(label, path, expected, init) {
  let response;
  let body = null;
  try {
    response = await fetch(`${baseUrl}${path}`, init);
    const text = await response.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  } catch (error) {
    failures.push(`${label}: request threw ${String(error)}`);
    return null;
  }
  const expectedList = Array.isArray(expected) ? expected : [expected];
  if (!expectedList.includes(response.status)) {
    failures.push(
      `${label}: expected ${expectedList.join(" or ")}, got ${response.status} ${JSON.stringify(body)}`,
    );
    return body;
  }
  // Spec §17: every error response is {"error": "<description>"}.
  if (response.status >= 400 && (typeof body !== "object" || body === null)) {
    failures.push(`${label}: error body is not a JSON object: ${JSON.stringify(body)}`);
    return body;
  }
  if (response.status >= 400 && response.status !== 413) {
    const hasError = typeof body.error === "string" && body.error.length > 0;
    // POST /logs answers an all-rejected batch with the accepted/rejected shape
    // rather than a bare error, which is the documented contract for that path.
    const hasRejected = Array.isArray(body.rejected);
    if (!hasError && !hasRejected) {
      failures.push(`${label}: error body missing "error" string: ${JSON.stringify(body)}`);
      return body;
    }
  }
  passed += 1;
  return body;
}

const json = (payload) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: typeof payload === "string" ? payload : JSON.stringify(payload),
});

const now = new Date();
const iso = now.toISOString();

// ---------------------------------------------------------------- limit
await expectStatus("limit=abc", "/logs?limit=abc", 400);
await expectStatus("limit=50x", "/logs?limit=50x", 400);
await expectStatus("limit=1e3", "/logs?limit=1e3", 400);
await expectStatus("limit=0", "/logs?limit=0", 400);
await expectStatus("limit=1001", "/logs?limit=1001", 400);
await expectStatus("limit=-1", "/logs?limit=-1", 400);
await expectStatus("limit= (empty)", "/logs?limit=", 400);
await expectStatus("limit=1000 (boundary, valid)", "/logs?limit=1000", 200);
await expectStatus("limit=1 (boundary, valid)", "/logs?limit=1", 200);

// ------------------------------------------------------------ timestamps
await expectStatus("since=not-a-date", "/logs?since=not-a-date", 400);
await expectStatus("until=2026-13-45", "/logs?until=2026-13-45", 400);
await expectStatus(
  "until earlier than since",
  "/logs?since=2026-08-02T00:00:00Z&until=2026-08-01T00:00:00Z",
  400,
);
await expectStatus(
  "since without explicit zone",
  "/logs?since=2026-08-02T00:00:00",
  400,
);
await expectStatus(
  "empty but valid range",
  "/logs?since=2000-01-01T00:00:00Z&until=2000-01-02T00:00:00Z",
  200,
);

// ---------------------------------------------------------- enumerations
await expectStatus("level=critical", "/logs?level=critical", 400);
await expectStatus("bucket=7m", `/logs/aggregate?since=${iso}&until=${iso}&bucket=7m`, 400);
await expectStatus(
  "group_by=message",
  `/logs/aggregate?since=${iso}&until=${iso}&bucket=1m&group_by=message`,
  400,
);
await expectStatus("aggregate without since", `/logs/aggregate?until=${iso}&bucket=1m`, 400);
await expectStatus("aggregate without until", `/logs/aggregate?since=${iso}&bucket=1m`, 400);
await expectStatus("aggregate without bucket", `/logs/aggregate?since=${iso}&until=${iso}`, 400);

// --------------------------------------------------------------- cursors
await expectStatus("cursor=garbage", "/logs?cursor=garbage", 400);
await expectStatus("cursor empty", "/logs?cursor=", 400);
await expectStatus("cursor without signature", "/logs?cursor=abcdef", 400);

const firstPage = await expectStatus("mint a cursor", "/logs?limit=1", 200);
if (firstPage !== null && typeof firstPage.next_cursor === "string") {
  const valid = firstPage.next_cursor;
  await expectStatus("valid cursor replayed", `/logs?limit=1&cursor=${encodeURIComponent(valid)}`, 200);
  await expectStatus(
    "cursor with a flipped signature",
    `/logs?limit=1&cursor=${encodeURIComponent(`${valid.slice(0, -1)}${valid.at(-1) === "A" ? "B" : "A"}`)}`,
    400,
  );
  await expectStatus(
    "truncated cursor",
    `/logs?limit=1&cursor=${encodeURIComponent(valid.slice(0, valid.length - 6))}`,
    400,
  );
  await expectStatus(
    "cursor replayed under a different filter",
    `/logs?limit=1&level=error&cursor=${encodeURIComponent(valid)}`,
    400,
  );
} else {
  failures.push("could not mint a cursor to test replay cases");
}

// ------------------------------------------------- literal search operators
// These must be treated as literal text. Under LIKE, % and _ are wildcards and
// \ is an escape; a naive implementation returns the whole table for `q=%`.
const wildcard = await expectStatus("q=% (literal)", "/logs?q=%25&limit=5", 200);
const unfiltered = await expectStatus("unfiltered reference", "/logs?limit=5", 200);
if (wildcard !== null && unfiltered !== null && Array.isArray(wildcard.logs)) {
  const looksLikeWildcard =
    wildcard.logs.length === unfiltered.logs.length &&
    wildcard.logs.length > 0 &&
    wildcard.logs[0]?.id === unfiltered.logs[0]?.id;
  if (looksLikeWildcard) {
    failures.push("q=% behaved as a wildcard: it returned the unfiltered head of the table");
  } else {
    passed += 1;
  }
}
await expectStatus("q=a_b (literal)", "/logs?q=a_b&limit=5", 200);
await expectStatus("q=back\\slash (literal)", "/logs?q=back%5Cslash&limit=5", 200);

// ------------------------------------------------------------- attributes
await expectStatus("attr. with empty key", "/logs?attr.=x", 400);
await expectStatus("attr with no value", "/logs?attr.trace_id=", 200);

// ------------------------------------------------------ duplicate parameters
await expectStatus("duplicate service parameter", "/logs?service=a&service=b", [200, 400]);
await expectStatus("duplicate limit parameter", "/logs?limit=5&limit=10", [200, 400]);

// --------------------------------------------------------- injection probes
const injections = [
  "x' OR '1'='1",
  "'; DROP TABLE logs; --",
  "1); DELETE FROM logs WHERE (1=1",
  "\\'; SELECT pg_sleep(10); --",
  "' UNION SELECT null,null,null,null,null,null --",
];
for (const probe of injections) {
  await expectStatus(
    `injection via service: ${probe.slice(0, 24)}`,
    `/logs?service=${encodeURIComponent(probe)}&limit=5`,
    [200, 400],
  );
  await expectStatus(
    `injection via q: ${probe.slice(0, 24)}`,
    `/logs?q=${encodeURIComponent(probe)}&limit=5`,
    [200, 400],
  );
  await expectStatus(
    `injection via attribute key: ${probe.slice(0, 24)}`,
    `/logs?attr.${encodeURIComponent(probe)}=1&limit=5`,
    [200, 400],
  );
  await expectStatus(
    `injection via attribute value: ${probe.slice(0, 24)}`,
    `/logs?attr.trace_id=${encodeURIComponent(probe)}&limit=5`,
    [200, 400],
  );
}

// -------------------------------------------------------------- ingestion
await expectStatus("malformed JSON", "/logs", 400, json("{bad-json"));
await expectStatus("body is an array", "/logs", 400, json([]));
await expectStatus("body is a string", "/logs", 400, json('"nope"'));
await expectStatus("missing logs key", "/logs", 400, json({ entries: [] }));
await expectStatus("logs is not an array", "/logs", 400, json({ logs: {} }));
await expectStatus("empty logs array", "/logs", 400, json({ logs: [] }));
await expectStatus(
  "all entries invalid",
  "/logs",
  400,
  json({ logs: [{ timestamp: iso, level: "fatal", service: "s", message: "m" }] }),
);

const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
const mixed = await expectStatus(
  "future timestamp rejected, siblings accepted",
  "/logs",
  200,
  json({
    logs: [
      { timestamp: iso, level: "info", service: "reliability", message: "ok" },
      { timestamp: future, level: "info", service: "reliability", message: "too far ahead" },
      { timestamp: iso, level: "info", service: "reliability", message: "also ok" },
    ],
  }),
);
if (mixed !== null) {
  if (mixed.accepted !== 2) failures.push(`expected 2 accepted, got ${mixed.accepted}`);
  else if (mixed.rejected?.[0]?.index !== 1) {
    failures.push(`expected rejected index 1, got ${JSON.stringify(mixed.rejected)}`);
  } else passed += 1;
}

const structured = await expectStatus(
  "nested and array attributes rejected per entry",
  "/logs",
  200,
  json({
    logs: [
      { timestamp: iso, level: "info", service: "reliability", message: "flat", attributes: { a: 1 } },
      { timestamp: iso, level: "info", service: "reliability", message: "nested", attributes: { a: { b: 1 } } },
      { timestamp: iso, level: "info", service: "reliability", message: "array", attributes: { a: [1, 2] } },
    ],
  }),
);
if (structured !== null) {
  const rejectedIndexes = (structured.rejected ?? []).map((item) => item.index);
  if (structured.accepted !== 1 || rejectedIndexes.join(",") !== "1,2") {
    failures.push(
      `expected 1 accepted and rejected [1,2], got accepted=${structured.accepted} rejected=${JSON.stringify(rejectedIndexes)}`,
    );
  } else passed += 1;
}

// A null byte is valid JSON but cannot be stored in a PostgreSQL text column.
// It must be caught per entry: if it reaches the batch, the whole group-commit
// transaction aborts and every valid sibling is rejected with it.
const nullByte = await expectStatus(
  "null byte rejected per entry, siblings survive",
  "/logs",
  200,
  json({
    logs: [
      { timestamp: iso, level: "info", service: "reliability", message: "clean" },
      { timestamp: iso, level: "info", service: "reliability", message: "null byte" },
      { timestamp: iso, level: "info", service: "null svc", message: "bad service" },
      { timestamp: iso, level: "info", service: "reliability", message: "ok", attributes: { k: "v " } },
    ],
  }),
);
if (nullByte !== null) {
  if (nullByte.accepted !== 1) {
    failures.push(`null-byte batch: expected 1 accepted, got ${nullByte.accepted}`);
  } else passed += 1;
}

// --------------------------------------------------------------- routing
await expectStatus("unknown route", "/does-not-exist", 404);
await expectStatus("wrong method on /logs", "/logs", 404, { method: "DELETE" });

console.log(
  JSON.stringify({ checksPassed: passed, failures: failures.length, status: failures.length === 0 ? "ok" : "failed" }, null, 2),
);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL  ${failure}`);
  process.exit(1);
}
