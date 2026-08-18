import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import type { DatabasePools } from "./db/pools.js";
import { isDatabaseUnavailable } from "./db/pools.js";
import { HttpError } from "./errors.js";
import type { WriteBatcher } from "./ingest/batcher.js";
import { validateIngestBody } from "./ingest/validation.js";
import type { CursorCodec } from "./query/cursor.js";
import { parseAggregateQuery, parseLogQuery } from "./query/parser.js";
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

export function createApp(dependencies: AppDependencies): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  app.set("query parser", "simple");
  app.use(express.json({ limit: dependencies.bodyLimit, strict: true }));

  app.get("/health", async (_request, response) => {
    if (!dependencies.isReady()) {
      response.status(503).json({ status: "starting" });
      return;
    }
    try {
      await dependencies.pools.query.query("SELECT 1");
      response.status(200).json({ status: "ok" });
    } catch {
      response.status(503).json({ status: "unavailable" });
    }
  });

  app.post("/logs", asyncRoute(async (request, response) => {
    const result = validateIngestBody(request.body, Date.now(), dependencies.maxLogAgeMs);
    if (result.logs.length === 0) {
      response.status(400).json({ accepted: 0, rejected: result.rejected });
      return;
    }
    await dependencies.batcher.submit(result.logs, result.estimatedBytes);
    response.status(200).json({ accepted: result.logs.length, rejected: result.rejected });
  }));

  app.get("/logs", asyncRoute(async (request, response) => {
    const parsed = parseLogQuery(request.query, dependencies.cursors);
    const page = await dependencies.queries.list(parsed);
    response.status(200).json({ logs: page.logs, next_cursor: page.nextCursor });
  }));

  app.get("/logs/aggregate", asyncRoute(async (request, response) => {
    const parsed = parseAggregateQuery(request.query);
    const buckets = await dependencies.queries.aggregate(parsed);
    response.status(200).json({ buckets });
  }));

  app.get("/metrics", (_request, response) => {
    response.status(200).json({ ingestion: dependencies.batcher.metrics });
  });

  app.use((_request, response) => {
    response.status(404).json({ error: "not found" });
  });

  const errors: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof HttpError) {
      if (error.retryAfterSeconds !== undefined) {
        response.setHeader("Retry-After", String(error.retryAfterSeconds));
      }
      response.status(error.status).json({ error: error.message });
      return;
    }
    if (isMalformedJson(error)) {
      response.status(400).json({ error: "malformed JSON" });
      return;
    }
    if (isEntityTooLarge(error)) {
      response.status(413).json({ error: "request body is too large" });
      return;
    }
    // The database being down, restarting, or saturated is a server-side
    // availability problem, not a bad request and not an internal defect. It
    // must be a retryable 503 so a client backs off instead of discarding the
    // batch, and so an outage never shows up as a 500.
    if (isDatabaseUnavailable(error)) {
      response.setHeader("Retry-After", "1");
      response.status(503).json({ error: "database is unavailable" });
      return;
    }
    console.error(JSON.stringify({
      event: "request_error",
      message: error instanceof Error ? error.message : "unknown error",
    }));
    response.status(500).json({ error: "internal server error" });
  };
  app.use(errors);
  return app;
}

function asyncRoute(
  handler: (request: Parameters<RequestHandler>[0], response: Parameters<RequestHandler>[1]) => Promise<void>,
): RequestHandler {
  return (request, response, next) => {
    void handler(request, response).catch(next);
  };
}

function isMalformedJson(error: unknown): boolean {
  return (
    error instanceof SyntaxError &&
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    (error as { type?: unknown }).type === "entity.parse.failed"
  );
}

function isEntityTooLarge(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    (error as { type?: unknown }).type === "entity.too.large"
  );
}
