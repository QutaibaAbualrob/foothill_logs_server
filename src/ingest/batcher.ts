import type { AggregateCounters } from "../aggregate/counters.js";
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
    private readonly counters?: AggregateCounters,
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

    // No size threshold triggers a flush. A flush already in progress absorbs
    // everything that arrives while it runs — ensureTimer is a no-op then, and
    // the flush re-pumps whatever accumulated as soon as it commits. The timer
    // therefore only covers the idle case, where a lone request would otherwise
    // wait for a companion that never comes.
    this.ensureTimer();
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

  /**
   * Takes the whole queue. A flush pays a fixed cost — connection checkout,
   * BEGIN, SET LOCAL, the rollup upsert, COMMIT — that is independent of how
   * many rows it carries, so capping the batch below what is already waiting
   * spends that cost again for no reason and leaves the rest of the backlog to
   * wait for the next round trip. Admission control in submit() is what bounds
   * memory: queueMaxRows and queueMaxBytes cap what can ever be waiting here,
   * and csvChunks streams the batch out in fixed-size pieces rather than
   * materialising it.
   */
  private takeBatch(): PendingRequest[] {
    const pending = this.queue.splice(0, this.queue.length);
    let rows = 0;
    for (const request of pending) rows += request.logs.length;
    this.queuedRows = 0;
    this.queuedBytes = 0;
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
      // After the commit and before the acknowledgement, in that order. The
      // client draining the log can only count rows whose POST returned, so
      // counters updated ahead of the resolve can never report fewer rows than
      // the caller has been told are durable. A failed flush rejects instead and
      // never reaches here, so nothing uncommitted is ever counted.
      this.counters?.add(logs);
      this.committedRows += totalRows;
      for (const request of pending) request.resolve();
    } catch (error) {
      this.failedFlushes += 1;
      for (const request of pending) request.reject(error);
    } finally {
      this.inFlightRows = 0;
      this.flushing = false;
      // Everything that arrived during this flush goes out in the next one,
      // with no delay: the writer is free and the backlog is already known.
      if (this.queue.length > 0) this.pump();
      this.finishClose();
    }
  }

  private finishClose(): void {
    if (this.closing && !this.flushing && this.queue.length === 0) this.resolveClose?.();
  }
}
