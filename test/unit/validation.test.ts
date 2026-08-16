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
