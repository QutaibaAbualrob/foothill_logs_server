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
      // The GIN index (jsonb_path_ops) only answers containment, so the filter
      // is narrowed by a containment disjunction and then rechecked exactly.
      //
      // Both halves are required. Containment alone is *broader* than `->>`
      // equality for numbers, because jsonb compares numerics rather than
      // their text: `attributes @> '{"k":1.0}'` matches a stored `1`, while
      // `attributes ->> 'k'` renders that as '1' and must not match a query
      // for '1.0'. Containment alone is also narrower for the JSON type it
      // names, which is why every scalar type the value could have been stored
      // as gets its own containment term. Their union is a superset of `->>`
      // equality, so ANDing the exact predicate back on reproduces the old
      // semantics precisely while letting the index do the selection.
      const containment = containmentVariants(key, value).map(
        (json) => `attributes @> ${parameter(json)}::jsonb`,
      );
      conditions.push(`(${containment.join(" OR ")})`);
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

/** A JSON number as PostgreSQL will accept it into jsonb. */
const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

/** A literal whose mantissa really is zero, as opposed to one that underflowed. */
const LITERAL_ZERO = /^-?0(\.0+)?([eE][+-]?\d+)?$/;

/**
 * Every JSON scalar an attribute could have been stored as whose `->>`
 * rendering is `value`, as containment documents to probe the GIN index with.
 *
 * A filter value arrives from the query string as text, but ingest accepts
 * strings, numbers and booleans (see validateAttributes), and `->>` flattens
 * all three to text. `attr.retry=1` must therefore still find `{"retry": 1}`
 * as well as `{"retry": "1"}`.
 */
function containmentVariants(key: string, value: string): string[] {
  const variants = [JSON.stringify({ [key]: value })];
  if (JSON_NUMBER.test(value) && isStorableNumber(value)) {
    // Emitted as raw JSON rather than via JSON.stringify(Number(value)) so the
    // literal keeps the scale it was written with: PostgreSQL stores jsonb
    // numbers as numeric, where 1.0 and 1 are equal, and re-serialising
    // through a JavaScript double would silently drop a trailing zero.
    variants.push(`{${JSON.stringify(key)}:${value}}`);
  }
  if (value === "true" || value === "false") {
    variants.push(`{${JSON.stringify(key)}:${value}}`);
  }
  return variants;
}

/**
 * True when `value` is a number some stored attribute could actually have been,
 * which is the only case worth probing the index for — and, more importantly,
 * the only case PostgreSQL will accept as a jsonb literal.
 *
 * An exponent outside the double range is the trap. `1e999999` parses to
 * Infinity and is easy to reject, but `1e-999999` parses to a perfectly finite
 * 0 while PostgreSQL rejects the literal outright with "value overflows numeric
 * format" — which would turn a well-formed query into a 500. No ingested value
 * can carry such an exponent (attributes arrive as doubles), so dropping the
 * numeric term loses no match: the string term still applies, and the `->>`
 * recheck still decides.
 */
function isStorableNumber(value: string): boolean {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return false;
  return parsed !== 0 || LITERAL_ZERO.test(value);
}
