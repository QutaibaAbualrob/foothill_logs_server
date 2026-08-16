import type { LogLevel } from "../types.js";

export interface QueryFilters {
  readonly service?: string;
  readonly level?: LogLevel;
  readonly since?: string;
  readonly until?: string;
  readonly q?: string;
  readonly attributes: Readonly<Record<string, string>>;
}

export interface CursorKey {
  readonly timestamp: string;
  readonly id: string;
}

export interface ParsedLogQuery {
  readonly filters: QueryFilters;
  readonly limit: number;
  readonly cursor?: CursorKey;
  readonly filterHash: string;
}

export type Bucket = "1m" | "5m" | "1h" | "1d";
export type GroupBy = "service" | "level";

export interface ParsedAggregateQuery {
  readonly filters: QueryFilters & { readonly since: string; readonly until: string };
  readonly bucket: Bucket;
  readonly groupBy?: GroupBy;
}

export interface AggregateResult {
  readonly start: string;
  readonly group: string | null;
  readonly count: number;
}
