import type { Pool, QueryResultRow } from "pg";
import { HttpError } from "../errors.js";
import { isDatabaseUnavailable } from "../db/pools.js";
import type { Attributes, LogLevel, LogResult } from "../types.js";
import { buildPredicates } from "./builder.js";
import { CursorCodec } from "./cursor.js";
import type { AggregateResult, ParsedAggregateQuery, ParsedLogQuery, QueryFilters } from "./types.js";

interface LogRow extends QueryResultRow {
  readonly id: string;
  readonly timestamp_text: string;
  readonly level: LogLevel;
  readonly service: string;
  readonly message: string;
  readonly attributes: Attributes;
}

interface AggregateRow extends QueryResultRow {
  readonly start: string;
  readonly group_value: string | null;
  readonly count: string;
}

const BUCKET_SECONDS = { "1m": 60, "5m": 300, "1h": 3_600, "1d": 86_400 } as const;

const MINUTE_MS = 60_000;

export interface EdgeSlices {
  readonly alignedSince: string;
  readonly alignedUntil: string;
  readonly hasLeft: boolean;
  readonly hasRight: boolean;
}

/**
 * Splits [since, until) into a whole-minute interior plus at most two
 * partial edge minutes (plan §6 "Exact edges").
 *
 * alignedSince is `since` rounded UP to the next minute boundary and
 * alignedUntil is `until` rounded DOWN, so the rollup table — which only
 * stores whole minutes — can answer [alignedSince, alignedUntil) directly.
 * Whatever is left over on either side must come from the raw table, so a
 * whole edge minute is never counted into a range that does not contain it.
 * When the whole range sits inside one minute, alignedSince >= alignedUntil
 * and the caller must fall back to a single raw query.
 *
 * Date.parse truncates to milliseconds while PostgreSQL stores microseconds,
 * so a string that parses to an exact minute boundary may still be strictly
 * past it (since) or before it (until) when it carries non-zero sub-ms
 * digits. The effective instant is bumped by one millisecond in that case,
 * which rounds the boundary to the correct side — the same precision class
 * the cursor design defends against.
 */
export function computeEdgeSlices(sinceIso: string, untilIso: string): EdgeSlices {
  const sinceMs = Date.parse(sinceIso);
  const untilMs = Date.parse(untilIso);
  // Date.parse truncates to milliseconds while PostgreSQL stores microseconds:
  // a value whose ms-truncation lands exactly on a minute boundary may still
  // be strictly past it (or before it) when non-zero sub-ms digits exist.
  const sinceOnBoundary = sinceMs % MINUTE_MS === 0;
  const untilOnBoundary = untilMs % MINUTE_MS === 0;
  const sinceSubMs = hasNonZeroSubMilliseconds(sinceIso);
  const untilSubMs = hasNonZeroSubMilliseconds(untilIso);
  // First whole minute >= the true since: normally the ceil of the ms value,
  // but a boundary value with sub-ms digits is strictly past that boundary,
  // so the next boundary is the first one that contains the true instant.
  const alignedSinceMs =
    sinceOnBoundary && sinceSubMs ? sinceMs + MINUTE_MS : Math.ceil(sinceMs / MINUTE_MS) * MINUTE_MS;
  const alignedUntilMs = Math.floor(untilMs / MINUTE_MS) * MINUTE_MS;
  return {
    alignedSince: new Date(alignedSinceMs).toISOString(),
    alignedUntil: new Date(alignedUntilMs).toISOString(),
    hasLeft: !sinceOnBoundary || sinceSubMs,
    hasRight: !untilOnBoundary || untilSubMs,
  };
}

/** True when the ISO string carries non-zero digits beyond millisecond precision. */
function hasNonZeroSubMilliseconds(iso: string): boolean {
  const match = /\.(\d{1,9})(Z|[+-])/.exec(iso);
  if (match === null || match[1] === undefined || match[1].length <= 3) return false;
  return /[1-9]/.test(match[1].slice(3));
}

export class PgLogQueryRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly cursors: CursorCodec,
    private readonly hotAttributeKeys: readonly string[] = [],
  ) {}

  public async list(query: ParsedLogQuery): Promise<{ logs: LogResult[]; nextCursor: string | null }> {
    const predicates = buildPredicates(query.filters, query.cursor, this.hotAttributeKeys);
    predicates.values.push(query.limit + 1);
    try {
      // Both ORDER BY columns are table-qualified, and must stay that way.
      // SQL resolves an unqualified ORDER BY name against the OUTPUT columns
      // first, so a bare "id" binds to the "id::text" alias below and sorts
      // lexicographically, where '9' sorts after '12'. That disagrees with the
      // keyset predicate in builder.ts, which compares id as bigint: rows that
      // share a timestamp are then skipped mid-walk while the response still
      // reports a clean next_cursor. It also costs the plan its pure backward
      // index scan, adding an Incremental Sort node above the Merge Append.
      const result = await this.pool.query<LogRow>(
        `SELECT logs.id::text AS id,
                to_char(logs.timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS timestamp_text,
                logs.level, logs.service, logs.message, logs.attributes
         FROM logs
         ${predicates.sql}
         ORDER BY logs.timestamp DESC, logs.id DESC
         LIMIT $${String(predicates.values.length)}`,
        predicates.values,
      );
      const hasMore = result.rows.length > query.limit;
      const rows = hasMore ? result.rows.slice(0, query.limit) : result.rows;
      const last = rows.at(-1);
      return {
        logs: rows.map((row) => ({
          id: row.id,
          timestamp: row.timestamp_text,
          level: row.level,
          service: row.service,
          message: row.message,
          attributes: row.attributes,
        })),
        nextCursor:
          hasMore && last !== undefined
            ? this.cursors.encode({ timestamp: last.timestamp_text, id: last.id }, query.filterHash)
            : null,
      };
    } catch (error) {
      if (isDatabaseUnavailable(error)) throw new HttpError(503, "database is unavailable", 1);
      throw error;
    }
  }

  public async aggregate(query: ParsedAggregateQuery): Promise<AggregateResult[]> {
    // The rollup table only stores the service and level dimensions, so a q
    // search or any attribute filter must always scan the raw table. Time
    // alignment no longer decides the path: when the range is usable, the
    // rollup answers its whole-minute interior and small raw queries answer
    // the partial edge minutes.
    const canUseRollup =
      query.filters.q === undefined &&
      Object.keys(query.filters.attributes).length === 0;
    try {
      const rows = canUseRollup
        ? await this.aggregateWithEdgeSlices(query)
        : await this.aggregateRaw(query);
      return rows.map((row) => ({
        start: row.start,
        group: row.group_value,
        count: safeCount(row.count),
      }));
    } catch (error) {
      if (isDatabaseUnavailable(error)) throw new HttpError(503, "database is unavailable", 1);
      throw error;
    }
  }

  /**
   * Rollup interior plus exact raw slices for the partial edge minutes
   * (plan §6). When the whole range falls inside a single minute there is
   * no interior, so one raw query answers exactly as the raw path would.
   */
  private async aggregateWithEdgeSlices(query: ParsedAggregateQuery): Promise<AggregateRow[]> {
    const { since, until } = query.filters;
    const edges = computeEdgeSlices(since, until);
    if (Date.parse(edges.alignedSince) >= Date.parse(edges.alignedUntil)) {
      return this.aggregateRaw(query);
    }
    const parts: AggregateRow[][] = [
      await this.aggregateRollup(query, edges.alignedSince, edges.alignedUntil),
    ];
    if (edges.hasLeft) {
      parts.push(await this.aggregateRaw(query, { since, until: edges.alignedSince }));
    }
    if (edges.hasRight) {
      parts.push(await this.aggregateRaw(query, { since: edges.alignedUntil, until }));
    }
    return mergeAggregateRows(parts);
  }

  private async aggregateRollup(
    query: ParsedAggregateQuery,
    since: string,
    until: string,
  ): Promise<AggregateRow[]> {
    const values: unknown[] = [since, until];
    const conditions = ["bucket_start >= $1::timestamptz", "bucket_start < $2::timestamptz"];
    if (query.filters.service !== undefined) {
      values.push(query.filters.service);
      conditions.push(`service = $${String(values.length)}`);
    }
    if (query.filters.level !== undefined) {
      values.push(query.filters.level);
      conditions.push(`level = $${String(values.length)}`);
    }
    const seconds = BUCKET_SECONDS[query.bucket];
    const bucket = `to_timestamp(floor(extract(epoch FROM bucket_start) / ${seconds}) * ${seconds})`;
    const group = query.groupBy === undefined ? "NULL::text" : query.groupBy;
    const result = await this.pool.query<AggregateRow>(
      `SELECT to_char((${bucket}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS start,
              ${group} AS group_value,
              SUM(count)::text AS count
       FROM logs_agg_1m
       WHERE ${conditions.join(" AND ")}
       GROUP BY ${query.groupBy === undefined ? "1" : "1, 2"}
       ORDER BY 1 ASC, 2 ASC NULLS FIRST`,
      values,
    );
    return result.rows;
  }

  private async aggregateRaw(
    query: ParsedAggregateQuery,
    bounds?: { readonly since: string; readonly until: string },
  ): Promise<AggregateRow[]> {
    const filters: QueryFilters =
      bounds === undefined
        ? query.filters
        : { ...query.filters, since: bounds.since, until: bounds.until };
    const predicates = buildPredicates(filters, undefined, this.hotAttributeKeys);
    const seconds = BUCKET_SECONDS[query.bucket];
    const bucket = `to_timestamp(floor(extract(epoch FROM timestamp) / ${seconds}) * ${seconds})`;
    const group = query.groupBy === undefined ? "NULL::text" : query.groupBy;
    const result = await this.pool.query<AggregateRow>(
      `SELECT to_char((${bucket}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS start,
              ${group} AS group_value,
              COUNT(*)::text AS count
       FROM logs
       ${predicates.sql}
       GROUP BY ${query.groupBy === undefined ? "1" : "1, 2"}
       ORDER BY 1 ASC, 2 ASC NULLS FIRST`,
      predicates.values,
    );
    return result.rows;
  }
}

interface MergedAggregateRow {
  readonly start: string;
  readonly groupValue: string | null;
  count: bigint;
}

/**
 * Combines the interior and edge result sets, summing counts that land in
 * the same (bucket, group) pair as BIGINT so no intermediate value can
 * overflow before safeCount validates the final totals. Summing is required
 * for correctness: for buckets larger than one minute, an edge slice and
 * the rollup interior re-bucket into the same bucket start (a 5m bucket
 * holds minutes 12:01-12:04 from the interior and the 12:00:30-12:01:00
 * edge), and both paths must add together.
 */
function mergeAggregateRows(parts: readonly AggregateRow[][]): AggregateRow[] {
  const merged = new Map<string, MergedAggregateRow>();
  for (const rows of parts) {
    for (const row of rows) {
      const key = `${row.start}\u0000${row.group_value ?? ""}`;
      const existing = merged.get(key);
      if (existing === undefined) {
        merged.set(key, { start: row.start, groupValue: row.group_value, count: BigInt(row.count) });
      } else {
        existing.count += BigInt(row.count);
      }
    }
  }
  return [...merged.values()]
    .sort(compareMergedRows)
    .map((row) => ({ start: row.start, group_value: row.groupValue, count: String(row.count) }));
}

/** Mirrors the SQL ORDER BY 1 ASC, 2 ASC NULLS FIRST. */
function compareMergedRows(left: MergedAggregateRow, right: MergedAggregateRow): number {
  if (left.start !== right.start) return left.start < right.start ? -1 : 1;
  if (left.groupValue === null) return right.groupValue === null ? 0 : -1;
  if (right.groupValue === null) return 1;
  return left.groupValue < right.groupValue ? -1 : left.groupValue > right.groupValue ? 1 : 0;
}

export function safeCount(value: string): number {
  const count = BigInt(value);
  if (count < 0n || count > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("aggregate count exceeds JSON safe integer range");
  }
  return Number(count);
}
