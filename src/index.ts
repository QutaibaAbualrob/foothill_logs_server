import { createServer } from "node:http";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { closePools, createPools, probeDatabase } from "./db/pools.js";
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

await migrate(pools.maintenance, config.retentionDays, config.hotAttributeKeys);
await probeDatabase(pools.query);

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
await retention.start();
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
