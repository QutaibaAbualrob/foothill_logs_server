import type { Pool, QueryResultRow } from "pg";
import { HttpError } from "../errors.js";
import { isPoolTimeout } from "../db/pools.js";
import type { Attributes, LogLevel, LogResult } from "../types.js";
import { buildPredicates } from "./builder.js";
import { CursorCodec } from "./cursor.js";
import type { AggregateResult, ParsedAggregateQuery, ParsedLogQuery } from "./types.js";

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
      if (isPoolTimeout(error)) throw new HttpError(503, "query pool is busy", 1);
      throw error;
    }
  }

  public async aggregate(query: ParsedAggregateQuery): Promise<AggregateResult[]> {
    const canUseRollup =
      query.filters.q === undefined &&
      Object.keys(query.filters.attributes).length === 0 &&
      Date.parse(query.filters.since) % 60_000 === 0 &&
      Date.parse(query.filters.until) % 60_000 === 0;
    try {
      const rows = canUseRollup
        ? await this.aggregateRollup(query)
        : await this.aggregateRaw(query);
      return rows.map((row) => ({
        start: row.start,
        group: row.group_value,
        count: safeCount(row.count),
      }));
    } catch (error) {
      if (isPoolTimeout(error)) throw new HttpError(503, "query pool is busy", 1);
      throw error;
    }
  }

  private async aggregateRollup(query: ParsedAggregateQuery): Promise<AggregateRow[]> {
    const values: unknown[] = [query.filters.since, query.filters.until];
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

  private async aggregateRaw(query: ParsedAggregateQuery): Promise<AggregateRow[]> {
    const predicates = buildPredicates(query.filters, undefined, this.hotAttributeKeys);
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
