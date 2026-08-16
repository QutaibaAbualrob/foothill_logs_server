import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../../src/errors.js";
import { buildPredicates } from "../../src/query/builder.js";
import { CursorCodec, filterHash } from "../../src/query/cursor.js";
import { parseAggregateQuery, parseLogQuery } from "../../src/query/parser.js";
import { computeEdgeSlices, safeCount } from "../../src/query/repository.js";
import type { QueryFilters } from "../../src/query/types.js";

const codec = new CursorCodec("test-secret");

test("cursor round-trips exact microseconds and is bound to filters", () => {
  const filters: QueryFilters = { service: "checkout", attributes: { trace_id: "m" } };
  const hash = filterHash(filters);
  const encoded = codec.encode(
    { timestamp: "2026-08-16T12:00:00.123456Z", id: "9007199254740993" },
    hash,
  );
  assert.deepEqual(codec.decode(encoded, hash), {
    timestamp: "2026-08-16T12:00:00.123456Z",
    id: "9007199254740993",
  });
  assert.throws(
    () => codec.decode(encoded, filterHash({ attributes: {} })),
    (error: unknown) => error instanceof HttpError && error.status === 400,
  );
});

test("cursor rejects tampering", () => {
  const hash = filterHash({ attributes: {} });
  const encoded = codec.encode({ timestamp: "2026-08-16T12:00:00.000001Z", id: "1" }, hash);
  assert.throws(() => codec.decode(`${encoded}x`, hash), HttpError);
});

test("query parser combines filters and validates strict limits", () => {
  const parsed = parseLogQuery(
    {
      service: "checkout",
      level: "error",
      since: "2026-08-01T00:00:00Z",
      until: "2026-08-16T00:00:00Z",
      "attr.trace_id": "visible-1",
      limit: "1000",
    },
    codec,
  );
  assert.equal(parsed.limit, 1000);
  assert.equal(parsed.filters.attributes.trace_id, "visible-1");
  assert.throws(() => parseLogQuery({ limit: "50x" }, codec), HttpError);
  assert.throws(() => parseLogQuery({ level: "fatal" }, codec), HttpError);
});

test("aggregate parser requires valid bounds and a supported bucket", () => {
  const parsed = parseAggregateQuery({
    since: "2026-08-01T00:00:00Z",
    until: "2026-08-02T00:00:00Z",
    bucket: "1h",
    group_by: "service",
  });
  assert.equal(parsed.bucket, "1h");
  assert.equal(parsed.groupBy, "service");
  assert.throws(() => parseAggregateQuery({ bucket: "1m" }), HttpError);
});

test("query parsers compare timestamp bounds at nanosecond precision", () => {
  const reversed = {
    since: "2026-08-16T12:00:00.000002Z",
    until: "2026-08-16T12:00:00.000001Z",
  };
  const isBadRequest = (error: unknown) => error instanceof HttpError && error.status === 400;

  assert.throws(() => parseLogQuery(reversed, codec), isBadRequest);
  assert.throws(() => parseAggregateQuery({ ...reversed, bucket: "1m" }), isBadRequest);
  assert.throws(
    () =>
      parseLogQuery(
        {
          since: "2026-08-16T12:00:00.000002+02:00",
          until: "2026-08-16T10:00:00.000001Z",
        },
        codec,
      ),
    isBadRequest,
  );

  const ordered = parseAggregateQuery({
    since: "2026-08-16T12:00:00.000001Z",
    until: "2026-08-16T12:00:00.000002Z",
    bucket: "1m",
  });
  assert.equal(ordered.filters.since, "2026-08-16T12:00:00.000001Z");
  assert.equal(ordered.filters.until, "2026-08-16T12:00:00.000002Z");
});

test("SQL builder binds every user value and never interpolates one", () => {
  const built = buildPredicates(
    {
      service: "x' OR true --",
      q: "100%_literal",
      attributes: { trace_id: "m'", "odd-key": "value" },
    },
    undefined,
    ["trace_id"],
  );
  // No user-supplied string may appear in the SQL text.
  assert.doesNotMatch(built.sql, /x' OR true/);
  assert.doesNotMatch(built.sql, /odd-key/);
  assert.doesNotMatch(built.sql, /m'/);
  assert.ok(built.values.includes("x' OR true --"));
  assert.ok(built.values.includes("100%_literal"));
  assert.ok(built.values.includes("odd-key"));
  assert.ok(built.values.includes("m'"));
});

test("a configured hot attribute key emits the partial-index predicate", () => {
  const built = buildPredicates({ attributes: { trace_id: "abc" } }, undefined, ["trace_id"]);
  // The literal key and the repeated existence test are what allow the planner
  // to use the partial expression index; the compared value stays a parameter.
  assert.match(built.sql, /attributes \? 'trace_id'/);
  assert.match(built.sql, /\(attributes ->> 'trace_id'\) = \$1/);
  assert.deepEqual(built.values, ["abc"]);
});

test("an unconfigured attribute key stays fully parameterised", () => {
  const built = buildPredicates({ attributes: { trace_id: "abc" } }, undefined, []);
  assert.doesNotMatch(built.sql, /'trace_id'/);
  assert.match(built.sql, /\(attributes ->> \$1\) = \$2/);
  assert.deepEqual(built.values, ["trace_id", "abc"]);
});

test("q is matched literally so wildcards cannot be injected through it", () => {
  const built = buildPredicates({ q: "100%_x\\y", attributes: {} });
  // strpos is a literal substring search: % _ \ carry no special meaning,
  // unlike LIKE, where all three would.
  assert.match(built.sql, /strpos\(lower\(message\), lower\(\$1\)\) > 0/);
  assert.doesNotMatch(built.sql, /LIKE/i);
  assert.deepEqual(built.values, ["100%_x\\y"]);
});

test("aggregate counts remain JSON-safe", () => {
  assert.equal(safeCount("1000000"), 1_000_000);
  assert.throws(() => safeCount("9007199254740992"));
});

test("edge slices: an aligned range has no edges and a full-minute interior", () => {
  assert.deepEqual(computeEdgeSlices("2026-08-16T12:00:00Z", "2026-08-16T12:05:00Z"), {
    alignedSince: "2026-08-16T12:00:00.000Z",
    alignedUntil: "2026-08-16T12:05:00.000Z",
    hasLeft: false,
    hasRight: false,
  });
});

test("edge slices: unaligned bounds produce an interior plus left and right edges", () => {
  assert.deepEqual(computeEdgeSlices("2026-08-16T12:00:30.123Z", "2026-08-16T12:05:30.456Z"), {
    alignedSince: "2026-08-16T12:01:00.000Z",
    alignedUntil: "2026-08-16T12:05:00.000Z",
    hasLeft: true,
    hasRight: true,
  });
});

test("edge slices: a range inside one minute has an empty interior", () => {
  const slices = computeEdgeSlices("2026-08-16T12:00:30Z", "2026-08-16T12:00:50Z");
  assert.equal(slices.alignedSince >= slices.alignedUntil, true);
});

test("edge slices: only the trailing edge exists when since is aligned", () => {
  assert.deepEqual(computeEdgeSlices("2026-08-16T12:00:00Z", "2026-08-16T12:05:30Z"), {
    alignedSince: "2026-08-16T12:00:00.000Z",
    alignedUntil: "2026-08-16T12:05:00.000Z",
    hasLeft: false,
    hasRight: true,
  });
});

test("edge slices: sub-millisecond digits past a minute boundary are not truncated away", () => {
  // 12:00:00.000001 is strictly inside minute 12:00, but Date.parse truncates
  // it to 12:00:00.000 — treating it as aligned would hand the rollup a whole
  // edge minute it does not contain. The bump must force a left edge.
  assert.deepEqual(computeEdgeSlices("2026-08-16T12:00:00.000001Z", "2026-08-16T12:05:00Z"), {
    alignedSince: "2026-08-16T12:01:00.000Z",
    alignedUntil: "2026-08-16T12:05:00.000Z",
    hasLeft: true,
    hasRight: false,
  });
  // Symmetrically for until: 12:05:00.000001 excludes the instant 12:05:00.000000,
  // so the interior must stop at 12:05:00 and a right edge covers the remainder.
  assert.deepEqual(computeEdgeSlices("2026-08-16T12:00:00Z", "2026-08-16T12:05:00.000001Z"), {
    alignedSince: "2026-08-16T12:00:00.000Z",
    alignedUntil: "2026-08-16T12:05:00.000Z",
    hasLeft: false,
    hasRight: true,
  });
});
