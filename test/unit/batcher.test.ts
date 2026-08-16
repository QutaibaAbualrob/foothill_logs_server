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
    retentionDays: 30,
    retentionIntervalMs: 3600000,
    retentionBatchRows: 5000,
    batchTargetRows: 2,
    batchMaxRows: 5,
    batchTargetBytes: 10000,
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

test("batcher rejects work beyond its bounded queue", async () => {
  const repository = new FakeRepository();
  repository.block = new Promise<void>(() => undefined);
  const batcher = new WriteBatcher(repository, config({ queueMaxRows: 2, batchTargetRows: 1 }));
  void batcher.submit([log], 100).catch(() => undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  void batcher.submit([log], 100).catch(() => undefined);
  await assert.rejects(
    batcher.submit([log], 100),
    (error: unknown) => error instanceof HttpError && error.status === 503,
  );
});
