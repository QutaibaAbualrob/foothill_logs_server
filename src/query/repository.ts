import type { Pool, QueryResultRow } from "pg";
import type { AggregateCounters } from "../aggregate/counters.js";
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

const SECOND_MS = 1_000;

/**
 * A bucket start in exactly the form the SQL path emits. Buckets are always a
 * whole number of seconds and never finer than a minute, so the fractional
 * part is always zero — but it has to carry six digits, because to_char writes
 * microseconds and the two paths must agree byte for byte.
 */
function formatBucketStart(epochSeconds: number): string {
  return `${new Date(epochSeconds * SECOND_MS).toISOString().slice(0, -1)}000Z`;
}

export interface EdgeSlices {
  readonly alignedSince: string;
  readonly alignedUntil: string;
  readonly hasLeft: boolean;
  readonly hasRight: boolean;
}

/**
 * Splits [since, until) into a whole-unit interior plus at most two partial
 * edges (plan §6 "Exact edges"). `unitMs` defaults to a minute, which is the
 * rollup table's granularity; the in-process counters pass a second.
 *
 * alignedSince is `since` rounded UP to the next unit boundary and
 * alignedUntil is `until` rounded DOWN, so a store that only holds whole
 * units — the rollup table, or the counters — can answer
 * [alignedSince, alignedUntil) directly.
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
export function computeEdgeSlices(
  sinceIso: string,
  untilIso: string,
  unitMs: number = MINUTE_MS,
): EdgeSlices {
  const sinceMs = Date.parse(sinceIso);
  const untilMs = Date.parse(untilIso);
  // Date.parse truncates to milliseconds while PostgreSQL stores microseconds:
  // a value whose ms-truncation lands exactly on a unit boundary may still
  // be strictly past it (or before it) when non-zero sub-ms digits exist.
  const sinceOnBoundary = sinceMs % unitMs === 0;
  const untilOnBoundary = untilMs % unitMs === 0;
  const sinceSubMs = hasNonZeroSubMilliseconds(sinceIso);
  const untilSubMs = hasNonZeroSubMilliseconds(untilIso);
  // First whole unit >= the true since: normally the ceil of the ms value,
  // but a boundary value with sub-ms digits is strictly past that boundary,
  // so the next boundary is the first one that contains the true instant.
  const alignedSinceMs =
    sinceOnBoundary && sinceSubMs ? sinceMs + unitMs : Math.ceil(sinceMs / unitMs) * unitMs;
  const alignedUntilMs = Math.floor(untilMs / unitMs) * unitMs;
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
    private readonly counters?: AggregateCounters,
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
      // The counters carry the same dimensions the rollup does, so they are
      // gated on the same filters — plus one more. Grouped queries stay on SQL:
      // a grouped result has to order by the group value, and reproducing the
      // database's text collation in JavaScript is a correctness risk taken for
      // no gain, because the aggregate callers on the hot path do not group.
      if (canUseRollup && query.groupBy === undefined) {
        const cached = await this.aggregateFromCounters(query);
        if (cached !== null) return cached;
      }
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
   * Answers from the in-process counters, or null when they cannot answer
   * exactly and the SQL path has to run.
   */
  private async aggregateFromCounters(query: ParsedAggregateQuery): Promise<AggregateResult[] | null> {
    const counters = this.counters;
    if (counters === undefined || !counters.enabled) return null;

    const { since, until, service, level } = query.filters;
    const sinceMs = Date.parse(since);
    const untilMs = Date.parse(until);
    if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) return null;
    // Coverage is a lower bound and nothing else. There is deliberately no
    // upper-bound test: the counters see every row this process commits, so a
    // window ending in the future is covered, and simply empty past the newest
    // row. A client draining the log sets until slightly in the future, so a
    // rule requiring the window to end at or before the newest data would
    // silently route exactly that caller back to SQL and buy nothing.
    if (!counters.covers(sinceMs)) return null;

    const edges = computeEdgeSlices(since, until, SECOND_MS);
    const interiorFromSec = Date.parse(edges.alignedSince) / SECOND_MS;
    const interiorToSec = Date.parse(edges.alignedUntil) / SECOND_MS;
    // A window narrower than the second containing it has no whole-second
    // interior, and its two edges would overlap rather than abut. Not a shape
    // the hot path produces, and the SQL path answers it correctly.
    if (interiorToSec <= interiorFromSec) return null;

    const bucketSeconds = BUCKET_SECONDS[query.bucket];
    const totals = new Map<string, number>();
    const interior = counters.scan(interiorFromSec, interiorToSec, service, level, bucketSeconds);
    for (const [startSec, count] of interior) {
      totals.set(formatBucketStart(startSec), count);
    }

    // Each partial edge is at most one second of rows, and the counters already
    // know whether that second holds any. When it does not, the fragment is
    // dropped — which is what takes the common drain window to zero queries.
    const fragments: { readonly since: string; readonly until: string }[] = [];
    if (edges.hasLeft && counters.secondHasRows(Math.floor(sinceMs / SECOND_MS), service, level)) {
      fragments.push({ since, until: edges.alignedSince });
    }
    if (edges.hasRight && counters.secondHasRows(Math.floor(untilMs / SECOND_MS), service, level)) {
      fragments.push({ since: edges.alignedUntil, until });
    }
    if (fragments.length > 0) {
      for (const row of await this.aggregateRawUnion(query, fragments)) {
        totals.set(row.start, (totals.get(row.start) ?? 0) + safeCount(row.count));
      }
    }

    // A fixed-width UTC ISO-8601 start sorts identically as text and as an
    // instant, so ordering needs no collation — which is the reason grouped
    // queries are not served from here at all.
    return [...totals]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([start, count]) => ({ start, group: null, count }));
  }

  /**
   * The given raw ranges as a single statement. Only the ungrouped shape is
   * built, because that is the only shape the counters serve.
   */
  private async aggregateRawUnion(
    query: ParsedAggregateQuery,
    bounds: readonly { readonly since: string; readonly until: string }[],
  ): Promise<AggregateRow[]> {
    const seconds = BUCKET_SECONDS[query.bucket];
    const values: unknown[] = [];
    const branches = bounds.map((range) => {
      const predicates = buildPredicates(
        { ...query.filters, since: range.since, until: range.until },
        undefined,
        this.hotAttributeKeys,
        values.length,
      );
      values.push(...predicates.values);
      return `SELECT to_timestamp(floor(extract(epoch FROM timestamp) / ${String(seconds)}) * ${String(seconds)}) AS bucket,
                     COUNT(*)::bigint AS total
              FROM logs
              ${predicates.sql}
              GROUP BY 1`;
    });
    const result = await this.pool.query<AggregateRow>(
      `SELECT to_char(bucket AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS start,
              NULL::text AS group_value,
              SUM(total)::text AS count
       FROM (${branches.join(" UNION ALL ")}) parts
       GROUP BY 1
       ORDER BY 1 ASC`,
      values,
    );
    return result.rows;
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
    // One round trip, not three. The interior and both edges are cheap
    // individually — the rollup holds a few hundred rows and an edge covers at
    // most one partial minute — but each separate statement is another pool
    // acquisition that queues for the database CPU behind an in-flight flush.
    // Three of those serialise into an aggregate latency that no single query
    // explains. UNION ALL is mergeAggregateRows expressed in SQL: the outer
    // GROUP BY sums an edge and the interior that re-bucket to the same start,
    // which a bucket wider than one minute always produces.
    const combined = this.buildCombinedAggregate(query, edges);
    const result = await this.pool.query<AggregateRow>(combined.sql, combined.values);
    return result.rows;
  }

  /**
   * The rollup interior plus each present edge as one statement. Every branch
   * appends to a single parameter list, so each must be built with an offset
   * equal to the number of values already bound (see buildPredicates).
   */
  private buildCombinedAggregate(
    query: ParsedAggregateQuery,
    edges: EdgeSlices,
  ): { sql: string; values: unknown[] } {
    const { since, until } = query.filters;
    const seconds = BUCKET_SECONDS[query.bucket];
    const group = query.groupBy === undefined ? "NULL::text" : query.groupBy;
    const grouping = query.groupBy === undefined ? "1" : "1, 2";
    const values: unknown[] = [];
    const parameter = (value: unknown): string => {
      values.push(value);
      return `$${String(values.length)}`;
    };

    const rollupConditions = [
      `bucket_start >= ${parameter(edges.alignedSince)}::timestamptz`,
      `bucket_start < ${parameter(edges.alignedUntil)}::timestamptz`,
    ];
    if (query.filters.service !== undefined) {
      rollupConditions.push(`service = ${parameter(query.filters.service)}`);
    }
    if (query.filters.level !== undefined) {
      rollupConditions.push(`level = ${parameter(query.filters.level)}`);
    }
    const branches: string[] = [
      `SELECT to_timestamp(floor(extract(epoch FROM bucket_start) / ${String(seconds)}) * ${String(seconds)}) AS bucket,
              ${group} AS group_value,
              SUM(count)::bigint AS total
       FROM logs_agg_1m
       WHERE ${rollupConditions.join(" AND ")}
       GROUP BY ${grouping}`,
    ];

    const edgeBranch = (bounds: { readonly since: string; readonly until: string }): string => {
      const predicates = buildPredicates(
        { ...query.filters, since: bounds.since, until: bounds.until },
        undefined,
        this.hotAttributeKeys,
        values.length,
      );
      values.push(...predicates.values);
      return `SELECT to_timestamp(floor(extract(epoch FROM timestamp) / ${String(seconds)}) * ${String(seconds)}) AS bucket,
                     ${group} AS group_value,
                     COUNT(*)::bigint AS total
              FROM logs
              ${predicates.sql}
              GROUP BY ${grouping}`;
    };
    if (edges.hasLeft) branches.push(edgeBranch({ since, until: edges.alignedSince }));
    if (edges.hasRight) branches.push(edgeBranch({ since: edges.alignedUntil, until }));

    // With no group_by the outer group_value must be re-emitted as the constant
    // NULL::text rather than selected from the subquery. PostgreSQL permits a
    // constant in the select list of a GROUP BY 1 query, but a column reference
    // has to be grouped or aggregated — selecting parts.group_value under
    // GROUP BY 1 is a hard 42803, which is what the branch inside the subquery
    // gets away with only because there it is itself the constant.
    const outerGroupValue = query.groupBy === undefined ? "NULL::text" : "group_value";
    return {
      sql: `SELECT to_char(bucket AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS start,
                   ${outerGroupValue} AS group_value,
                   SUM(total)::text AS count
            FROM (${branches.join(" UNION ALL ")}) parts
            GROUP BY ${grouping}
            ORDER BY 1 ASC, 2 ASC NULLS FIRST`,
      values,
    };
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

export function safeCount(value: string): number {
  const count = BigInt(value);
  if (count < 0n || count > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("aggregate count exceeds JSON safe integer range");
  }
  return Number(count);
}
