import assert from "node:assert/strict";
import test from "node:test";
import { isDatabaseUnavailable, isPoolTimeout } from "../../src/db/pools.js";

/** A driver/system error as node-postgres surfaces it: an Error with a code. */
function coded(code: string, message = "failure"): Error {
  return Object.assign(new Error(message), { code });
}

test("every way a database host fails to resolve counts as unavailable", () => {
  // Which code arrives depends on the resolver, not on the fault: a container
  // runtime answering NXDOMAIN for a stopped service gives ENOTFOUND, one
  // answering SERVFAIL gives EAI_AGAIN, for the identical outage. Listing only
  // ENOTFOUND mapped that second case to 500 instead of 503 + Retry-After.
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "EAI_NODATA", "EAI_FAIL"]) {
    assert.equal(
      isDatabaseUnavailable(coded(code, `getaddrinfo ${code} postgres`)),
      true,
      code,
    );
  }
});

test("unreachable, refused, and reset connections count as unavailable", () => {
  for (const code of ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ETIMEDOUT"]) {
    assert.equal(isDatabaseUnavailable(coded(code)), true, code);
  }
});

test("SQLSTATEs for a server that cannot serve right now count as unavailable", () => {
  for (const code of ["57P01", "57P03", "08006", "53300", "40P01", "55P03"]) {
    assert.equal(isDatabaseUnavailable(coded(code)), true, code);
  }
});

test("a lost connection is matched on message, having no SQLSTATE", () => {
  for (const message of [
    "Connection terminated unexpectedly",
    "Client has encountered a connection error and is not queryable",
    "terminating connection due to administrator command",
    "server closed the connection unexpectedly",
    "Cannot use a pool after calling end on the pool",
  ]) {
    assert.equal(isDatabaseUnavailable(new Error(message)), true, message);
  }
});

test("a pool checkout timeout is unavailable, and is recognised as a timeout", () => {
  const error = new Error("timeout exceeded when trying to connect");
  assert.equal(isPoolTimeout(error), true);
  assert.equal(isDatabaseUnavailable(error), true);
});

test("a client's own mistake is never reported as the database being down", () => {
  // These must stay 4xx/500 as appropriate. Widening the classifier until a
  // syntax error or a constraint violation reads as "unavailable" would turn
  // real defects into a retry loop that never surfaces them.
  for (const code of [
    "42601", // syntax_error
    "42P01", // undefined_table
    "23505", // unique_violation
    "22P02", // invalid_text_representation
    "57014", // query_canceled — statement_timeout fired; the server is alive
  ]) {
    assert.equal(isDatabaseUnavailable(coded(code)), false, code);
  }
  assert.equal(isDatabaseUnavailable(new Error("something else went wrong")), false);
  assert.equal(isDatabaseUnavailable("not an error"), false);
  assert.equal(isDatabaseUnavailable(undefined), false);
});
