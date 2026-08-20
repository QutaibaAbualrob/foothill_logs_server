import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "../../src/config.js";
import { HttpError } from "../../src/errors.js";
import { WriteBatcher } from "../../src/ingest/batcher.js";
import type { LogWriteRepository } from "../../src/ingest/repository.js";
import type { NormalizedLog } from "../../src/types.js";

class FakeRepository implements LogWriteRepository {
  public readonly batches: number[] = [];
  public block: Promise<void> | undefined;

  public async insertCommitted(logs: readonly NormalizedLog[]): Promise<void> {
    this.batches.push(logs.length);
    await this.block;
  }
}

const log: NormalizedLog = {
  timestamp: "2026-08-16T12:00:00.123456Z",
  level: "info",
  service: "svc",
  message: "message",
  attributes: {},
  attributesJson: "{}",
  estimatedBytes: 100,
};

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 8080,
    databaseUrl: "postgresql://unused",
    bodyLimit: "4mb",
    writePoolSize: 2,
    queryPoolSize: 8,
    databaseConnectTimeoutMs: 1000,
    queryStatementTimeoutMs: 10000,
    cursorSecret: "test",
    hotAttributeKeys: [],
    aggregateCache: true,
    retentionDays: 30,
    maxLogAgeDays: 0,
    retentionIntervalMs: 3600000,
    retentionBatchRows: 5000,
    batchDelayMs: 2,
    queueMaxRows: 10,
    queueMaxBytes: 10000,
    syncCommit: "off",
    shutdownTimeoutMs: 10000,
    ...overrides,
  };
}

test("batcher coalesces requests and resolves only after repository completion", async () => {
  const repository = new FakeRepository();
  let release = (): void => undefined;
  repository.block = new Promise<void>((resolve) => {
    release = resolve;
  });
  const batcher = new WriteBatcher(repository, config());
  let resolved = false;
  const first = batcher.submit([log], 100).then(() => {
    resolved = true;
  });
  const second = batcher.submit([log], 100);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(repository.batches, [2]);
  assert.equal(batcher.metrics.committedRows, 2);
  await batcher.close();
});

test("batcher drains the whole backlog into one flush", async () => {
  const repository = new FakeRepository();
  let release = (): void => undefined;
  repository.block = new Promise<void>((resolve) => {
    release = resolve;
  });
  const batcher = new WriteBatcher(repository, config({ queueMaxRows: 100 }));
  const first = batcher.submit([log], 100);
  // Let the idle timer fire, so the first flush is in flight and blocked.
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(repository.batches, [1]);

  // Everything that arrives while that flush is blocked must leave in a single
  // transaction once it commits, however many requests contributed to it.
  const queued = [
    batcher.submit([log, log], 200),
    batcher.submit([log], 100),
    batcher.submit([log, log, log], 300),
  ];
  release();

  await Promise.all([first, ...queued]);
  assert.deepEqual(repository.batches, [1, 6]);
  assert.equal(batcher.metrics.committedRows, 7);
  assert.equal(batcher.metrics.flushes, 2);
  await batcher.close();
});

test("batcher rejects work beyond its bounded queue", async () => {
  const repository = new FakeRepository();
  repository.block = new Promise<void>(() => undefined);
  const batcher = new WriteBatcher(repository, config({ queueMaxRows: 2 }));
  void batcher.submit([log], 100).catch(() => undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  void batcher.submit([log], 100).catch(() => undefined);
  await assert.rejects(
    batcher.submit([log], 100),
    (error: unknown) => error instanceof HttpError && error.status === 503,
  );
});
