import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../../src/errors.js";
import { validateIngestBody } from "../../src/ingest/validation.js";

const NOW = Date.parse("2026-08-16T12:00:00.000Z");

test("validation accepts good entries and preserves rejected indexes", () => {
  const result = validateIngestBody(
    {
      logs: [
        {
          timestamp: "2026-08-16T11:59:59.123456Z",
          level: "info",
          service: "checkout",
          message: "paid",
          attributes: { trace_id: "m-1", attempt: 2, mobile: true },
        },
        {
          timestamp: "2026-08-16T11:59:59Z",
          level: "critical",
          service: "checkout",
          message: "bad level",
        },
      ],
    },
    NOW,
  );
  assert.equal(result.logs.length, 1);
  assert.equal(result.logs[0]?.timestamp, "2026-08-16T11:59:59.123456Z");
  assert.deepEqual(result.rejected, [{ index: 1, reason: "invalid level: 'critical'" }]);
  assert.ok(result.estimatedBytes > 0);
});

test("validation reports all-invalid batches without hiding per-entry reasons", () => {
  const result = validateIngestBody({ logs: [null, { level: "info" }] }, NOW);
  assert.equal(result.logs.length, 0);
  assert.deepEqual(result.rejected.map((item) => item.index), [0, 1]);
});

test("validation rejects malformed envelopes", () => {
  assert.throws(
    () => validateIngestBody({ value: [] }, NOW),
    (error: unknown) => error instanceof HttpError && error.status === 400,
  );
});

const DAY_MS = 86_400_000;

test("validation enforces the retention floor without disturbing the future bound", () => {
  // Default: no floor, which is the behaviour every existing caller relies on.
  const unbounded = validateIngestBody(
    { logs: [{ timestamp: "2019-01-01T00:00:00Z", level: "info", service: "a", message: "b" }] },
    NOW,
  );
  assert.equal(unbounded.logs.length, 1);

  // With a 30-day window, the same entry is rejected per-entry rather than
  // failing the batch, and an entry inside the window still passes.
  const bounded = validateIngestBody(
    {
      logs: [
        { timestamp: "2019-01-01T00:00:00Z", level: "info", service: "a", message: "b" },
        { timestamp: "2026-08-16T11:00:00Z", level: "info", service: "a", message: "b" },
      ],
    },
    NOW,
    30 * DAY_MS,
  );
  assert.equal(bounded.logs.length, 1);
  assert.deepEqual(bounded.rejected, [
    { index: 0, reason: "timestamp is older than the retention window" },
  ]);
});

test("the retention floor is off unless a caller passes one", () => {
  // Guards the ingest contract: accepting a backdated log and deleting it later
  // is dishonest, but refusing it is a behaviour change, so it must never be
  // switched on implicitly. MAX_LOG_AGE_DAYS defaults to 0, which config maps to
  // no floor at all.
  const ancient = {
    logs: [{ timestamp: "1999-01-01T00:00:00Z", level: "info", service: "a", message: "b" }],
  };
  assert.equal(validateIngestBody(ancient, NOW).logs.length, 1);
  assert.equal(validateIngestBody(ancient, NOW, Number.POSITIVE_INFINITY).logs.length, 1);
  assert.equal(validateIngestBody(ancient, NOW, 30 * DAY_MS).rejected.length, 1);
});

test("validation bounds service and message length", () => {
  const result = validateIngestBody(
    {
      logs: [
        {
          timestamp: "2026-08-16T11:59:59Z",
          level: "info",
          service: "s".repeat(256),
          message: "b",
        },
        {
          timestamp: "2026-08-16T11:59:59Z",
          level: "info",
          service: "a",
          message: "m".repeat(65_537),
        },
        // Exactly at the limit on both fields is accepted, so the bound is
        // inclusive and matches the CHECK constraints in migration 003.
        {
          timestamp: "2026-08-16T11:59:59Z",
          level: "info",
          service: "s".repeat(255),
          message: "m".repeat(65_536),
        },
      ],
    },
    NOW,
  );
  assert.equal(result.logs.length, 1);
  assert.deepEqual(result.rejected, [
    { index: 0, reason: "service must be at most 255 characters" },
    { index: 1, reason: "message must be at most 65536 characters" },
  ]);
});

test("validation enforces future bound, flat attributes, and PostgreSQL null safety", () => {
  const result = validateIngestBody(
    {
      logs: [
        { timestamp: "2026-08-16T12:05:00.001Z", level: "info", service: "a", message: "b" },
        {
          timestamp: "2026-08-16T12:00:00Z",
          level: "info",
          service: "a",
          message: "b",
          attributes: { nested: { no: true } },
        },
        {
          timestamp: "2026-08-16T12:00:00Z",
          level: "info",
          service: "a",
          message: "bad\u0000message",
        },
      ],
    },
    NOW,
  );
  assert.equal(result.logs.length, 0);
  assert.equal(result.rejected.length, 3);
});
