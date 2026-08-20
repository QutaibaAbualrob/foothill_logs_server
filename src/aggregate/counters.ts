import type { Pool } from "pg";
import type { LogLevel, NormalizedLog } from "../types.js";

/**
 * Per-second ingest counters held in the app process, so the aggregate endpoint
 * can answer without touching PostgreSQL.
 *
 * Why per second and not per minute: the rollup table already buckets by
 * minute, and the cost it cannot avoid is the partial edge minute. A window
 * whose left edge lands inside live traffic makes that edge a scan of up to
 * sixty seconds of rows — at high ingest rates, hundreds of thousands of them —
 * while the whole-minute interior is a few hundred rollup rows. Counting by
 * second shrinks the part that has to be scanned by 60x, and when the boundary
 * second holds nothing the scan disappears entirely.
 *
 * The store is exact, never an estimate. The endpoint's contract is an exact
 * count, and the caller most likely to notice a wrong one is a client draining
 * the log right after writing it: it knows how many rows it was acknowledged
 * for and compares. A count that is merely close is simply a wrong answer.
 * Anything the store cannot answer exactly it declines, and the SQL path runs
 * instead.
 */

const SECOND_MS = 1_000;

/** How far back counters are kept. Queries reaching further fall through to SQL. */
export const WINDOW_MS = 2 * 60 * 60 * 1_000;

/**
 * A safety valve, not a working limit. A handful of services and levels puts a
 * two-hour window in the low tens of thousands of cells; a pathological service
 * cardinality is what this guards against. Tripping it disables the cache for
 * the life of the process rather than letting the map grow without bound.
 */
export const MAX_CELLS = 1_000_000;

/** Eviction is amortised onto ingest rather than run on a timer of its own. */
const EVICT_INTERVAL_MS = 30_000;

/**
 * NUL, because it is the one byte that cannot appear in a PostgreSQL text
 * value. A printable separator would let a service name containing it collide
 * with a different service/level pair.
 */
const KEY_SEPARATOR = "\u0000";

interface SecondCounters {
  /** Sum over every key, kept alongside so an unfiltered scan needs no iteration. */
  total: number;
  readonly byKey: Map<string, number>;
}

function cellKey(service: string, level: string): string {
  return `${service}${KEY_SEPARATOR}${level}`;
}

export class AggregateCounters {
  private readonly seconds = new Map<number, SecondCounters>();
  private cells = 0;
  /**
   * The oldest instant the counters can answer for. Starts at the hydration
   * lower bound and only ever moves forward, as eviction drops old seconds.
   */
  private retainedFromMs = Number.POSITIVE_INFINITY;
  private usable = false;
  private lastEvictMs = 0;

  public get enabled(): boolean {
    return this.usable;
  }

  /** Cell count, for tests and diagnostics. */
  public get size(): number {
    return this.cells;
  }

  /**
   * Loads every row already inside the window, before the service starts
   * listening. Reads the raw `logs` table, so there is no watermark to persist
   * and nothing to reconcile after a restart: the table is the truth and this
   * is a projection of it taken at a point where no request can be in flight.
   *
   * A failure here disables the cache and leaves the service healthy. The SQL
   * path answers every query on its own; the cache is an accelerator, and
   * refusing to start over a cold accelerator would turn a slow endpoint into
   * an outage.
   */
  public async hydrate(pool: Pool, nowMs: number = Date.now()): Promise<void> {
    const fromMs = nowMs - WINDOW_MS;
    try {
      const result = await pool.query<{ sec: string; service: string; level: string; count: string }>(
        `SELECT floor(extract(epoch FROM timestamp))::bigint::text AS sec,
                service, level, COUNT(*)::text AS count
         FROM logs
         WHERE timestamp >= $1::timestamptz
         GROUP BY 1, 2, 3`,
        [new Date(fromMs).toISOString()],
      );
      if (result.rows.length > MAX_CELLS) {
        this.disable("hydrate_over_cell_cap", result.rows.length);
        return;
      }
      for (const row of result.rows) {
        const count = Number(row.count);
        if (!Number.isSafeInteger(count) || count < 0) {
          this.disable("hydrate_bad_count", result.rows.length);
          return;
        }
        this.increment(Number(row.sec), row.service, row.level, count);
      }
      this.retainedFromMs = fromMs;
      this.lastEvictMs = nowMs;
      this.usable = true;
      console.log(JSON.stringify({ event: "aggregate_cache_hydrated", cells: this.cells, fromMs }));
    } catch (error) {
      this.seconds.clear();
      this.cells = 0;
      this.usable = false;
      console.error(JSON.stringify({
        event: "aggregate_cache_hydrate_failed",
        message: error instanceof Error ? error.message : "unknown error",
      }));
    }
  }

  /**
   * Records a committed batch. Must be called after the write commits and
   * before the ingest request resolves: a client draining the log can only
   * count rows whose POST was acknowledged, so updating the counters ahead of
   * the acknowledgement means they can never report fewer rows than the caller
   * has been told are durable.
   *
   * Rows older than the window are skipped rather than stored, which is exactly
   * consistent with what the store will answer: a query old enough to include
   * them fails the coverage test and is answered by SQL instead.
   */
  public add(logs: readonly NormalizedLog[]): void {
    if (!this.usable) return;
    for (const log of logs) {
      const ms = Date.parse(log.timestamp);
      if (!Number.isFinite(ms)) {
        this.disable("add_unparseable_timestamp", this.cells);
        return;
      }
      if (ms < this.retainedFromMs) continue;
      this.increment(Math.floor(ms / SECOND_MS), log.service, log.level, 1);
      if (this.cells > MAX_CELLS) {
        this.disable("add_over_cell_cap", this.cells);
        return;
      }
    }
    this.evictIfDue();
  }

  /** True when the counters hold every row from `sinceMs` onward. */
  public covers(sinceMs: number): boolean {
    return this.usable && sinceMs >= this.retainedFromMs;
  }

  /**
   * Sums whole seconds in `[fromSec, toSec)` into buckets of `bucketSeconds`,
   * keyed by bucket start in epoch seconds. Only non-empty buckets are emitted,
   * matching a SQL GROUP BY, which produces no row for a bucket holding none.
   */
  public scan(
    fromSec: number,
    toSec: number,
    service: string | undefined,
    level: LogLevel | undefined,
    bucketSeconds: number,
  ): Map<number, number> {
    const buckets = new Map<number, number>();
    const match = this.matcher(service, level);
    for (let sec = fromSec; sec < toSec; sec += 1) {
      const entry = this.seconds.get(sec);
      if (entry === undefined) continue;
      const count = match === null ? entry.total : match(entry);
      if (count === 0) continue;
      const start = Math.floor(sec / bucketSeconds) * bucketSeconds;
      buckets.set(start, (buckets.get(start) ?? 0) + count);
    }
    return buckets;
  }

  /**
   * Whether one second holds any matching row. A partial edge second holding
   * none needs no SQL fragment at all, which is what takes the common drain
   * window to zero queries.
   */
  public secondHasRows(sec: number, service: string | undefined, level: LogLevel | undefined): boolean {
    const entry = this.seconds.get(sec);
    if (entry === undefined) return false;
    const match = this.matcher(service, level);
    return (match === null ? entry.total : match(entry)) > 0;
  }

  /**
   * A counting function for the filter, or null when nothing is filtered and
   * the precomputed total applies. Prefix and suffix tests avoid splitting the
   * composite key on a path that runs once per second of the window.
   */
  private matcher(
    service: string | undefined,
    level: LogLevel | undefined,
  ): ((entry: SecondCounters) => number) | null {
    if (service === undefined && level === undefined) return null;
    if (service !== undefined && level !== undefined) {
      const key = cellKey(service, level);
      return (entry) => entry.byKey.get(key) ?? 0;
    }
    if (service !== undefined) {
      const prefix = `${service}${KEY_SEPARATOR}`;
      return (entry) => {
        let total = 0;
        for (const [key, count] of entry.byKey) if (key.startsWith(prefix)) total += count;
        return total;
      };
    }
    const suffix = `${KEY_SEPARATOR}${String(level)}`;
    return (entry) => {
      let total = 0;
      for (const [key, count] of entry.byKey) if (key.endsWith(suffix)) total += count;
      return total;
    };
  }

  private increment(sec: number, service: string, level: string, by: number): void {
    let entry = this.seconds.get(sec);
    if (entry === undefined) {
      entry = { total: 0, byKey: new Map() };
      this.seconds.set(sec, entry);
    }
    const key = cellKey(service, level);
    const existing = entry.byKey.get(key);
    if (existing === undefined) this.cells += 1;
    entry.byKey.set(key, (existing ?? 0) + by);
    entry.total += by;
  }

  private evictIfDue(): void {
    const now = Date.now();
    if (now - this.lastEvictMs < EVICT_INTERVAL_MS) return;
    this.lastEvictMs = now;
    const cutoffMs = now - WINDOW_MS;
    const cutoffSec = Math.floor(cutoffMs / SECOND_MS);
    for (const [sec, entry] of this.seconds) {
      if (sec >= cutoffSec) continue;
      this.cells -= entry.byKey.size;
      this.seconds.delete(sec);
    }
    // Coverage shrinks to the cutoff whether or not anything was actually
    // dropped: a window with no rows in it still must not be claimed once the
    // seconds it spans are past the point where they would have been evicted.
    if (cutoffMs > this.retainedFromMs) this.retainedFromMs = cutoffMs;
  }

  private disable(reason: string, cells: number): void {
    this.usable = false;
    this.seconds.clear();
    this.cells = 0;
    console.error(JSON.stringify({ event: "aggregate_cache_disabled", reason, cells }));
  }
}
