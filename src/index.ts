import { createServer } from "node:http";
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
const writes = new PgLogWriteRepository(pools.write, config.syncCommit);
const batcher = new WriteBatcher(writes, config);
const queries = new PgLogQueryRepository(pools.query, cursors, config.hotAttributeKeys);
const retention = new RetentionWorker(pools.maintenance, config);
const app = createApp({
  pools,
  batcher,
  queries,
  cursors,
  bodyLimit: config.bodyLimit,
  maxLogAgeMs: config.retentionDays * 86_400_000,
  isReady: () => ready,
});
const server = createServer(app);
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 30_000;

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(config.port, "0.0.0.0", () => {
    server.off("error", reject);
    resolve();
  });
});
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
}));

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  ready = false;
  console.log(JSON.stringify({ event: "shutdown", signal }));
  const timeout = setTimeout(() => process.exit(1), config.shutdownTimeoutMs);
  timeout.unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
