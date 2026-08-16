import type { AppConfig } from "../config.js";
import { HttpError } from "../errors.js";
import type { NormalizedLog } from "../types.js";
import type { LogWriteRepository } from "./repository.js";

interface PendingRequest {
  readonly logs: readonly NormalizedLog[];
  readonly bytes: number;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

export interface BatcherMetrics {
  readonly queuedRows: number;
  readonly queuedBytes: number;
  readonly inFlightRows: number;
  readonly flushes: number;
  readonly committedRows: number;
  readonly failedFlushes: number;
}

export class WriteBatcher {
  private readonly queue: PendingRequest[] = [];
  private queuedRows = 0;
  private queuedBytes = 0;
  private inFlightRows = 0;
  private flushes = 0;
  private committedRows = 0;
  private failedFlushes = 0;
  private flushing = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private resolveClose: (() => void) | undefined;

  public constructor(
    private readonly repository: LogWriteRepository,
    private readonly config: AppConfig,
  ) {}

  public submit(logs: readonly NormalizedLog[], bytes: number): Promise<void> {
    if (this.closing) return Promise.reject(new HttpError(503, "service is shutting down", 1));
    const admittedRows = this.queuedRows + this.inFlightRows;
    if (
      admittedRows + logs.length > this.config.queueMaxRows ||
      this.queuedBytes + bytes > this.config.queueMaxBytes
    ) {
      return Promise.reject(new HttpError(503, "ingestion queue is full", 1));
    }

    const result = new Promise<void>((resolve, reject) => {
      this.queue.push({ logs, bytes, resolve, reject });
    });
    this.queuedRows += logs.length;
    this.queuedBytes += bytes;

    if (
      this.queuedRows >= this.config.batchTargetRows ||
      this.queuedBytes >= this.config.batchTargetBytes
    ) {
      this.clearTimer();
      this.pump();
    } else {
      this.ensureTimer();
    }
    return result;
  }

  public get metrics(): BatcherMetrics {
    return {
      queuedRows: this.queuedRows,
      queuedBytes: this.queuedBytes,
      inFlightRows: this.inFlightRows,
      flushes: this.flushes,
      committedRows: this.committedRows,
      failedFlushes: this.failedFlushes,
    };
  }

  public close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closing = true;
    this.clearTimer();
    this.closePromise = new Promise<void>((resolve) => {
      this.resolveClose = resolve;
    });
    this.pump();
    this.finishClose();
    return this.closePromise;
  }

  private ensureTimer(): void {
    if (this.timer !== undefined || this.flushing || this.queue.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, this.config.batchDelayMs);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private pump(): void {
    if (this.flushing || this.queue.length === 0) {
      this.finishClose();
      return;
    }
    this.flushing = true;
    const pending = this.takeBatch();
    void this.flush(pending);
  }

  private takeBatch(): PendingRequest[] {
    const pending: PendingRequest[] = [];
    let rows = 0;
    let bytes = 0;
    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (next === undefined) break;
      const wouldExceed =
        pending.length > 0 &&
        (rows + next.logs.length > this.config.batchMaxRows ||
          bytes + next.bytes > this.config.batchTargetBytes);
      if (wouldExceed) break;
      this.queue.shift();
      pending.push(next);
      rows += next.logs.length;
      bytes += next.bytes;
      if (rows >= this.config.batchTargetRows || bytes >= this.config.batchTargetBytes) break;
    }
    this.queuedRows -= rows;
    this.queuedBytes -= bytes;
    this.inFlightRows = rows;
    return pending;
  }

  private async flush(pending: readonly PendingRequest[]): Promise<void> {
    const totalRows = pending.reduce((total, item) => total + item.logs.length, 0);
    const logs = new Array<NormalizedLog>(totalRows);
    let index = 0;
    for (const request of pending) {
      for (const log of request.logs) logs[index++] = log;
    }
    this.flushes += 1;
    try {
      await this.repository.insertCommitted(logs);
      this.committedRows += totalRows;
      for (const request of pending) request.resolve();
    } catch (error) {
      this.failedFlushes += 1;
      for (const request of pending) request.reject(error);
    } finally {
      this.inFlightRows = 0;
      this.flushing = false;
      if (this.queue.length > 0) {
        if (this.closing || this.queuedRows >= this.config.batchTargetRows) this.pump();
        else this.ensureTimer();
      }
      this.finishClose();
    }
  }

  private finishClose(): void {
    if (this.closing && !this.flushing && this.queue.length === 0) this.resolveClose?.();
  }
}
