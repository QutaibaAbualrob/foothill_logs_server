import type { CursorKey, QueryFilters } from "./types.js";

export interface Predicates {
  readonly sql: string;
  readonly values: unknown[];
}

export function buildPredicates(
  filters: QueryFilters,
  cursor?: CursorKey,
  hotAttributeKeys: readonly string[] = [],
): Predicates {
  const conditions: string[] = [];
  const values: unknown[] = [];
  const hot = new Set(hotAttributeKeys);
  const parameter = (value: unknown): string => {
    values.push(value);
    return `$${String(values.length)}`;
  };

  if (filters.service !== undefined) conditions.push(`service = ${parameter(filters.service)}`);
  if (filters.level !== undefined) conditions.push(`level = ${parameter(filters.level)}`);
  if (filters.since !== undefined) {
    conditions.push(`timestamp >= ${parameter(filters.since)}::timestamptz`);
  }
  if (filters.until !== undefined) {
    conditions.push(`timestamp < ${parameter(filters.until)}::timestamptz`);
  }
  if (filters.q !== undefined) {
    conditions.push(`strpos(lower(message), lower(${parameter(filters.q)})) > 0`);
  }
  for (const [key, value] of Object.entries(filters.attributes)) {
    if (hot.has(key)) {
      // The index for this key is partial and expression-based:
      //   ON logs ((attributes ->> 'k'), timestamp DESC, id DESC)
      //   WHERE attributes ? 'k'
      // PostgreSQL matches an expression index by comparing expression trees,
      // and `attributes ->> $n` does not match `attributes ->> 'k'`. So the key
      // is emitted as a literal, and the partial predicate is repeated so the
      // planner is allowed to consider the index at all. Inlining is safe here
      // because `key` is a member of the configured hot-key set, which
      // config.ts restricts to the identifier character set — it is never the
      // client's string. The compared VALUE stays a bound parameter.
      const literal = `'${key}'`;
      conditions.push(`attributes ? ${literal}`);
      conditions.push(`(attributes ->> ${literal}) = ${parameter(value)}`);
    } else {
      conditions.push(`(attributes ->> ${parameter(key)}) = ${parameter(value)}`);
    }
  }
  if (cursor !== undefined) {
    conditions.push(
      `(timestamp, id) < (${parameter(cursor.timestamp)}::timestamptz, ${parameter(cursor.id)}::bigint)`,
    );
  }
  return { sql: conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`, values };
}
