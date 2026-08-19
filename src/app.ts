import { parse as parseQueryString } from "node:querystring";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { DatabasePools } from "./db/pools.js";
import { isDatabaseUnavailable } from "./db/pools.js";
import { HttpError } from "./errors.js";
import type { WriteBatcher } from "./ingest/batcher.js";
import { validateIngestBody } from "./ingest/validation.js";
import type { CursorCodec } from "./query/cursor.js";
import { parseAggregateQuery, parseLogQuery } from "./query/parser.js";
import type { RawQuery } from "./query/parser.js";
import type { PgLogQueryRepository } from "./query/repository.js";

export interface AppDependencies {
  readonly pools: DatabasePools;
  readonly batcher: WriteBatcher;
  readonly queries: PgLogQueryRepository;
  readonly cursors: CursorCodec;
  readonly bodyLimit: string;
  /** How far back an ingested timestamp may be, in milliseconds. */
  readonly maxLogAgeMs: number;
  readonly isReady: () => boolean;
}

export function createApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: false,
    // Fastify logs every request by default; the service emits its own
    // structured events and the 0.5-CPU budget cannot spare per-request logging.
    disableRequestLogging: true,
    bodyLimit: parseByteSize(dependencies.bodyLimit),
    // Express ran with `query parser: "simple"`, i.e. querystring semantics:
    // repeated keys become arrays and nothing is interpreted as nested. Keep
    // exactly that so `attr.<key>` stays one flat key and the parser's
    // duplicate-parameter rules are unchanged.
    querystringParser: (search) => parseQueryString(search),
  });

  app.get("/health", async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!dependencies.isReady()) {
      return reply.status(503).send({ status: "starting" });
    }
    try {
      await dependencies.pools.query.query("SELECT 1");
      return reply.status(200).send({ status: "ok" });
    } catch {
      return reply.status(503).send({ status: "unavailable" });
    }
  });

  app.post("/logs", async (request: FastifyRequest, reply: FastifyReply) => {
    const result = validateIngestBody(request.body, Date.now(), dependencies.maxLogAgeMs);
    if (result.logs.length === 0) {
      return reply.status(400).send({ accepted: 0, rejected: result.rejected });
    }
    await dependencies.batcher.submit(result.logs, result.estimatedBytes);
    return reply.status(200).send({ accepted: result.logs.length, rejected: result.rejected });
  });

  app.get("/logs", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = parseLogQuery(request.query as RawQuery, dependencies.cursors);
    const page = await dependencies.queries.list(parsed);
    return reply.status(200).send({ logs: page.logs, next_cursor: page.nextCursor });
  });

  app.get("/logs/aggregate", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = parseAggregateQuery(request.query as RawQuery);
    const buckets = await dependencies.queries.aggregate(parsed);
    return reply.status(200).send({ buckets });
  });

  app.get("/metrics", async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(200).send({ ingestion: dependencies.batcher.metrics });
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.status(404).send({ error: "not found" });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      if (error.retryAfterSeconds !== undefined) {
        void reply.header("Retry-After", String(error.retryAfterSeconds));
      }
      void reply.status(error.status).send({ error: error.message });
      return;
    }
    if (isMalformedJson(error)) {
      void reply.status(400).send({ error: "malformed JSON" });
      return;
    }
    if (isEntityTooLarge(error)) {
      void reply.status(413).send({ error: "request body is too large" });
      return;
    }
    // The database being down, restarting, or saturated is a server-side
    // availability problem, not a bad request and not an internal defect. It
    // must be a retryable 503 so a client backs off instead of discarding the
    // batch, and so an outage never shows up as a 500.
    if (isDatabaseUnavailable(error)) {
      void reply.header("Retry-After", "1");
      void reply.status(503).send({ error: "database is unavailable" });
      return;
    }
    // Fastify raises its own 4xx for things Express handled inside the body
    // parser — unsupported media type, bad content-length. Those are client
    // errors, and the reliability matrix treats any 500 as a defect, so honour
    // the framework's own status rather than mapping each code by hand.
    const status = frameworkClientErrorStatus(error);
    if (status !== undefined) {
      void reply.status(status).send({ error: error instanceof Error ? error.message : "bad request" });
      return;
    }
    console.error(JSON.stringify({
      event: "request_error",
      message: error instanceof Error ? error.message : "unknown error",
    }));
    void reply.status(500).send({ error: "internal server error" });
  });

  return app;
}

// Fastify wants a byte count where Express accepted "4mb". Same inputs, same
// meaning; an unparseable value is a configuration error and must not silently
// become an unlimited body.
export function parseByteSize(value: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?\s*$/i.exec(value);
  if (match === null) {
    throw new Error(`invalid body limit: ${value}`);
  }
  const units: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  const unit = match[2] === undefined ? "b" : match[2].toLowerCase();
  return Math.floor(Number(match[1]) * (units[unit] ?? 1));
}

// Fastify's own JSON parser reports a malformed body through these codes rather
// than through body-parser's `entity.parse.failed` type. Note the code is
// FST_ERR_CTP_INVALID_JSON_BODY in Fastify 5 — an empty body has its own code.
function isMalformedJson(error: unknown): boolean {
  return (
    hasCode(error, "FST_ERR_CTP_INVALID_JSON_BODY") || hasCode(error, "FST_ERR_CTP_EMPTY_JSON_BODY")
  );
}

function frameworkClientErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === "number" && status >= 400 && status < 500 ? status : undefined;
}

function isEntityTooLarge(error: unknown): boolean {
  return hasCode(error, "FST_ERR_CTP_BODY_TOO_LARGE");
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
