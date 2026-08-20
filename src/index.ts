import { AggregateCounters } from "./aggregate/counters.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { closePools, createPools, probeDatabase, withDatabaseRetry } from "./db/pools.js";
import { migrate } from "./db/migrate.js";
import { WriteBatcher } from "./ingest/batcher.js";
import { PgLogWriteRepository } from "./ingest/repository.js";
import { CursorCodec } from "./query/cursor.js";
import { PgLogQueryRepository } from "./query/repository.js";
import { RetentionWorker } from "./retention/worker.js";

const config = loadConfig();
const pools = createPools(config);
let ready = false;
let shuttingDown = false;

// Startup work that needs the database is retried rather than fatal. The
// container restart policy would otherwise convert a brief PostgreSQL outage
// into a crash loop: the process exits during migration, restarts while the
// database is still down, and exits again.
await withDatabaseRetry(
  () => migrate(pools.maintenance, config.retentionDays, config.hotAttributeKeys),
  { attempts: 30, baseDelayMs: 250, label: "migrate" },
);
await withDatabaseRetry(() => probeDatabase(pools.query), {
  attempts: 30,
  baseDelayMs: 250,
  label: "probe",
});

const cursors = new CursorCodec(config.cursorSecret);
const counters = config.aggregateCache ? new AggregateCounters() : undefined;
const writes = new PgLogWriteRepository(pools.write, config.syncCommit);
const batcher = new WriteBatcher(writes, config, counters);
const queries = new PgLogQueryRepository(pools.query, cursors, config.hotAttributeKeys, counters);
const retention = new RetentionWorker(pools.maintenance, config);
const app = createApp({
  pools,
  batcher,
  queries,
  cursors,
  bodyLimit: config.bodyLimit,
  maxLogAgeMs:
    config.maxLogAgeDays === 0
      ? Number.POSITIVE_INFINITY
      : config.maxLogAgeDays * 86_400_000,
  isReady: () => ready,
});
// Fastify creates and owns the HTTP server; the timeouts are set on it
// directly so they stay identical to the values the service shipped with.
app.server.keepAliveTimeout = 65_000;
app.server.headersTimeout = 66_000;
app.server.requestTimeout = 30_000;

// Before the socket opens, not merely before `ready`. Hydration is a
// projection of the table taken at an instant when no request can be in
// flight; opening the listener first would leave a window where a write could
// land between the read and the counters going live, and be counted twice or
// not at all. A failure inside hydrate() disables the cache and returns
// normally — the SQL path answers everything on its own.
await counters?.hydrate(pools.query);

await app.listen({ port: config.port, host: "0.0.0.0" });
ready = true;
// Retention is a background maintenance concern: if it cannot acquire its lock
// or reach the database at startup, the service still serves traffic.
await retention.start().catch((error: unknown) => {
  console.error(JSON.stringify({
    event: "retention_start_failed",
    message: error instanceof Error ? error.message : "unknown error",
  }));
});
console.log(JSON.stringify({
  event: "ready",
  port: config.port,
  syncCommit: config.syncCommit,
  writePool: config.writePoolSize,
  queryPool: config.queryPoolSize,
  aggregateCache: counters?.enabled ?? false,
}));

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  ready = false;
  console.log(JSON.stringify({ event: "shutdown", signal }));
  const timeout = setTimeout(() => process.exit(1), config.shutdownTimeoutMs);
  timeout.unref();
  await app.close();
  await batcher.close();
  await retention.stop();
  await closePools(pools);
  clearTimeout(timeout);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal).then(() => process.exit(0));
  });
}

// Last-resort guards. Every request path already maps database failures to a
// 503, so a rejection reaching here is a defect — but taking the process down
// would drop healthy in-flight requests and every queued batch with it. Log it
// with enough detail to fix, and stay up; the health check and the restart
// policy remain the backstop if the process is genuinely unwell.
process.on("unhandledRejection", (reason) => {
  console.error(JSON.stringify({
    event: "unhandled_rejection",
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  }));
});

process.on("uncaughtException", (error) => {
  console.error(JSON.stringify({
    event: "uncaught_exception",
    message: error.message,
    stack: error.stack,
  }));
});
