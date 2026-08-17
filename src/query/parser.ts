import { HttpError } from "../errors.js";
import { LOG_LEVELS, type LogLevel } from "../types.js";
import { CursorCodec, filterHash } from "./cursor.js";
import type { Bucket, GroupBy, ParsedAggregateQuery, ParsedLogQuery, QueryFilters } from "./types.js";

const LEVELS = new Set<string>(LOG_LEVELS);
const BUCKETS = new Set<Bucket>(["1m", "5m", "1h", "1d"]);
const GROUPS = new Set<GroupBy>(["service", "level"]);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const FRACTIONAL_SECONDS = /\.(\d{1,9})(?=Z|[+-]\d{2}:\d{2}$)/;

// Previously `Request["query"]` from Express. The shape is what
// `querystring.parse` produces, which is what the app configures Fastify to
// use, so the parser's semantics are unchanged by the framework swap.
export type RawQuery = Record<string, string | string[] | undefined>;

export function parseLogQuery(query: RawQuery, cursors: CursorCodec): ParsedLogQuery {
  const filters = parseFilters(query);
  const limitRaw = scalar(query.limit, "limit");
  const limit = limitRaw === undefined ? 100 : strictInteger(limitRaw, "limit", 1, 1_000);
  const hash = filterHash(filters);
  const cursorRaw = scalar(query.cursor, "cursor");
  const cursor = cursorRaw === undefined ? undefined : cursors.decode(cursorRaw, hash);
  return { filters, limit, filterHash: hash, ...(cursor === undefined ? {} : { cursor }) };
}

export function parseAggregateQuery(query: RawQuery): ParsedAggregateQuery {
  const filters = parseFilters(query);
  if (filters.since === undefined || filters.until === undefined) {
    throw new HttpError(400, "since and until are required");
  }
  const bucketRaw = scalar(query.bucket, "bucket");
  if (bucketRaw === undefined || !BUCKETS.has(bucketRaw as Bucket)) {
    throw new HttpError(400, "bucket must be one of 1m, 5m, 1h, or 1d");
  }
  const groupRaw = scalar(query.group_by, "group_by");
  if (groupRaw !== undefined && !GROUPS.has(groupRaw as GroupBy)) {
    throw new HttpError(400, "group_by must be service or level");
  }
  return {
    filters: { ...filters, since: filters.since, until: filters.until },
    bucket: bucketRaw as Bucket,
    ...(groupRaw === undefined ? {} : { groupBy: groupRaw as GroupBy }),
  };
}

function parseFilters(query: RawQuery): QueryFilters {
  const service = scalar(query.service, "service");
  const levelRaw = scalar(query.level, "level");
  if (levelRaw !== undefined && !LEVELS.has(levelRaw)) {
    throw new HttpError(400, "unsupported log level");
  }
  const since = optionalTimestamp(scalar(query.since, "since"), "since");
  const until = optionalTimestamp(scalar(query.until, "until"), "until");
  if (
    since !== undefined &&
    until !== undefined &&
    timestampNanoseconds(until) < timestampNanoseconds(since)
  ) {
    throw new HttpError(400, "until must not be earlier than since");
  }
  const q = scalar(query.q, "q");
  const attributes: Record<string, string> = {};
  for (const [key, raw] of Object.entries(query)) {
    if (!key.startsWith("attr.")) continue;
    const attributeKey = key.slice(5);
    if (attributeKey.length === 0 || attributeKey.includes("\u0000")) {
      throw new HttpError(400, "attribute filter key is invalid");
    }
    const value = scalar(raw, key);
    if (value === undefined) throw new HttpError(400, `${key} requires a value`);
    attributes[attributeKey] = value;
  }
  return {
    attributes,
    ...(service === undefined ? {} : { service }),
    ...(levelRaw === undefined ? {} : { level: levelRaw as LogLevel }),
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
    ...(q === undefined ? {} : { q }),
  };
}

function scalar(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${name} must be specified once`);
  return value;
}

function optionalTimestamp(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!ISO_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new HttpError(400, `${name} must be a valid ISO 8601 timestamp`);
  }
  return value;
}

function timestampNanoseconds(value: string): bigint {
  const fractional = FRACTIONAL_SECONDS.exec(value)?.[1] ?? "";
  const wholeSecond = value.replace(FRACTIONAL_SECONDS, "");
  return BigInt(Date.parse(wholeSecond)) * 1_000_000n + BigInt(fractional.padEnd(9, "0") || "0");
}

function strictInteger(value: string, name: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(value)) throw new HttpError(400, `${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(400, `${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}
