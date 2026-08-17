# Target Architecture

Derived from `search_rnd/RND.md` §3, §9, §10 and the project specification.
This document is the contract between the plan and the code: if the code and
this document disagree, one of them is a bug.

---

## 1. Shape

```text
                       ┌──────────────────────────────────────────┐
   POST /logs ────────▶│ validate per entry (mirrors DB limits)    │
                       │            ↓                              │
                       │ bounded queue  (rows AND bytes capped)    │
                       │            ↓                              │
                       │ group commit: N requests → 1 transaction  │
                       │   COPY raw rows  +  minute-rollup upsert  │
                       │            ↓                              │
                       │ COMMIT → resolve every waiting request    │
                       └──────────────────────────────────────────┘
                                          │
   GET /logs ──────────▶ parse → filter hash → keyset predicate ───┼──▶ PostgreSQL
   GET /logs/aggregate ▶ parse → rollup interior + raw edges ──────┤    (source of truth)
   GET /health ────────▶ readiness flag + maintenance-pool probe ──┤
                                                                   │
   retention worker ───▶ advisory lock → drop expired partitions ──┘
                         → bounded batched boundary delete
                         → same policy applied to the rollup table
```

Layering is strict (spec §27): HTTP handler → service → repository → SQL.
No SQL in a handler. No `Request` object below the handler.

---

## 2. Module map

| Path | Responsibility | Must not |
| --- | --- | --- |
| `src/index.ts` | Bootstrap: migrate → probe → listen → ready → signal handling | Contain business logic |
| `src/app.ts` | Routes, body limits, error mapping, 404 | Build SQL |
| `src/config.ts` | Strict env parsing, one typed config object | Read `process.env` anywhere else |
| `src/types.ts`, `src/errors.ts` | Shared types and `HttpError` | — |
| `src/db/pools.ts` | Three pools by role: write, query, maintenance | Be bypassed by `new Pool` elsewhere |
| `src/db/migrate.ts`, `migrations/*.sql` | Checksummed, advisory-locked, ordered migrations | Use `IF NOT EXISTS` as the only convergence mechanism |
| `src/ingest/validation.ts` | Per-entry validation that mirrors every DB constraint | Let the database be the validator |
| `src/ingest/batcher.ts` | Bounded queue, coalescing, group commit, backpressure | Resolve a request before its transaction commits |
| `src/ingest/repository.ts` | Bulk write mechanism + transactional rollup delta | Know about HTTP |
| `src/query/parser.ts` | Strict query-string parsing → typed query object | Accept permissive numeric or date parsing |
| `src/query/cursor.ts` | Opaque signed cursor: encode, decode, filter binding | Build a cursor timestamp from a JavaScript `Date` |
| `src/query/builder.ts` | Parameterised predicate fragments | Interpolate any user value into SQL |
| `src/query/repository.ts` | Page query, aggregate query, serialisation strategy | Contain parsing or validation |
| `src/retention/worker.ts` | Advisory-locked periodic retention | Share a pool with `/health` |

---

## 3. Schema

```sql
CREATE TABLE logs (
  timestamp  TIMESTAMPTZ NOT NULL,
  id         BIGINT GENERATED ALWAYS AS IDENTITY,
  level      TEXT NOT NULL CHECK (level IN ('debug','info','warn','error')),
  service    TEXT NOT NULL CHECK (length(service) > 0),
  message    TEXT NOT NULL CHECK (length(message) > 0),
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb
             CHECK (jsonb_typeof(attributes) = 'object'),
  PRIMARY KEY (timestamp, id)
) PARTITION BY RANGE (timestamp);
```

**Why these choices** (all four must appear in the README):

- **`BIGINT` identity, not UUID.** Monotonic keys give B-tree insertion locality;
  random keys fragment pages and inflate write amplification. Rendered as a JSON
  string in responses so no precision is lost in JavaScript.
- **`(timestamp, id)` primary key.** It *is* the pagination index. A backward
  scan serves `ORDER BY timestamp DESC, id DESC` with no sort node, which is
  what makes the keyset walk cheap. It also gives determinism on tied
  timestamps, which the spec requires (§14).
- **JSONB attributes, values kept in their original type.** Responses must return
  `3` and `true`, not `"3"` and `"true"`. `attr.<key>` equality stays a text
  comparison via `attributes ->> key = $n`, which is what preserves those
  semantics, but it is no longer answered by a scan: a `jsonb_path_ops` GIN
  index (`logs_attributes_gin_idx`, `fastupdate = off`) selects candidates by
  containment and the `->>` predicate rechecks them exactly. See the README's
  Indexes section for the measured cost of that index and why the recheck
  cannot be dropped.
- **Range partitioning on `timestamp`, monthly.** Retention becomes a partition
  drop instead of a mass `DELETE` — no bloat, no long lock, no vacuum storm
  (spec §29). Monthly granularity keeps the partition count low so an unfiltered
  descending page does not merge-append across dozens of children.

Partition window: pre-create the full retention window plus a forward margin at
startup. A `DEFAULT` partition exists only as a safety net and is treated as a
defect when non-empty — it escapes pruning and escapes retention. Retention must
sweep it.

### Rollup

```sql
CREATE TABLE logs_agg_1m (
  bucket_start TIMESTAMPTZ NOT NULL,
  service      TEXT NOT NULL,
  level        TEXT NOT NULL,
  count        BIGINT NOT NULL CHECK (count >= 0),
  PRIMARY KEY (bucket_start, service, level)
);
```

Written in the **same transaction** as the raw rows, so committed counts and
committed rows can never diverge. Deltas are aggregated in memory per batch and
upserted key-sorted, giving concurrent transactions a consistent lock order.
`BIGINT` counters throughout — a 32-bit cast is an overflow risk at retention
scale (research record §9.4).

Minute granularity re-buckets cleanly into `5m`, `1h`, and `1d`. It has its own
retention sweep in the same maintenance job that drops raw partitions; a raw
partition drop must never leave old counts queryable.

---

## 4. Ingestion path

1. **Validate every entry independently** against the API contract *and* every
   database constraint: level enum, non-empty service and message, attribute
   flatness, allowed value types, and rejection of characters PostgreSQL `text`
   cannot store (notably `\x00`, which JSON permits). Rejections carry the
   original array index.
   *Why it matters:* a value that passes JavaScript validation but violates a
   column constraint aborts the whole group-commit transaction and rejects every
   valid sibling — a direct violation of the partial-acceptance rule (spec §12).
2. **Normalise the timestamp exactly once** into a canonical UTC instant, and use
   that same value for the row, the rollup bucket, and the cursor. Never let
   JavaScript and PostgreSQL independently parse an ambiguous zone-less string;
   require an explicit offset.
3. **Enqueue** into a queue bounded by **both** row count and estimated bytes.
4. **Group commit.** Coalesce queued requests into one transaction: bulk-write
   the raw rows, upsert the rollup deltas, commit, then resolve every
   participating request. "Accepted" and "persisted and queryable" are the same
   event by construction, which is what makes the freshness requirement (§21)
   hold without a background reconciliation.
5. **Backpressure.** When the queue is full, respond `503` with `Retry-After`.
   Never a false `200` for uncommitted rows; never a `400` for server-side
   saturation.

Bulk mechanism: COPY CSV streamed in ~64 KiB chunks is the default. The
repository interface is deliberately narrow so an UNNEST-based multi-row INSERT
can be swapped in behind the same batcher and measured under an identical
workload. Whichever wins on measured throughput, p95, CPU and memory ships; not
whichever is theoretically faster.

---

## 5. Read path

This is where the remaining engineering budget goes (`00-MASTER-PLAN.md` §3).

### Cursor

- Keyset on `(timestamp, id)`, `ORDER BY timestamp DESC, id DESC`, fetching
  `limit + 1` to decide whether `next_cursor` is non-null.
- The cursor is anchored to the **last row actually returned**, never the probe
  row.
- The cursor timestamp is the **exact value PostgreSQL rendered**, at microsecond
  precision, carried as text and fed straight back into the next predicate. It
  is never round-tripped through a JavaScript `Date`. Our research record §12.9
  is explicit: `Date` keeps milliseconds, the column stores microseconds, and
  truncating the key silently skips every row sharing that millisecond — pages
  come back short and the walk ends early while reporting a clean `null`.
- The payload is versioned, HMAC-signed, and bound to a hash of the canonical
  active filter set. A cursor minted under one filter combination cannot be
  replayed against another. Tampered, malformed, or mismatched → `400`.
- Strict decoding: no scientific notation, no empty ids, nothing that passes a
  loose numeric check but fails a `bigint` cast and turns a `400` into a `500`.

### Page query

Target: **1,000 rows in ≤8 ms end-to-end.** The plan for reaching it:

- **Plan shape.** The page must be a pure backward index scan with no sort node
  and no count. Verified by `EXPLAIN (ANALYZE, BUFFERS)` for the unfiltered,
  service-filtered, and hot-attribute cases.
- **Serialisation.** Constructing 1,000 JavaScript objects and re-stringifying
  them costs application CPU we do not have (0.5 CPU) while PostgreSQL is idle
  during a drain. Candidate strategies, to be measured in Phase 4:
  A. driver rows → objects → `JSON.stringify` (baseline);
  B. PostgreSQL emits one JSON text per row, the application concatenates;
  C. PostgreSQL emits the whole array, the application writes it through.
  Whichever measures fastest under the caps ships.
- **Response write.** Bypass framework JSON serialisation; set the content type
  and write a prepared buffer.
- **Bounded read-ahead (optional, measured).** A sequential walk is predictable:
  after serving a page, speculatively run the query for the cursor just minted
  and hold the pre-serialised body in a small capped LRU keyed by that cursor.
  Additive, bounded to a few hundred KB, disabled under memory pressure, and
  incapable of changing results because it is the identical deterministic query.
  PostgreSQL remains the source of truth.

### Hot attribute key

A partial, ordered index supports correlation-ID style lookups that must also
return in cursor order:

```sql
CREATE INDEX logs_hot_attr_page_idx
  ON logs ((attributes ->> 'trace_id'), timestamp DESC, id DESC)
  WHERE attributes ? 'trace_id';
```

The key is configurable (`HOT_ATTRIBUTE_KEYS`), and the index is **partial** —
rows without that key are not indexed at all, so the write cost scales with how
often the key actually appears rather than with total ingest volume. This is the
general pattern our research record recommends for a high-selectivity attribute:
index the dimension you page by, not every dimension. The README documents it as
a configurable, opt-out optimisation with its measured write cost.

### Filters

Every filter is a fixed SQL fragment with bound parameters. Attribute keys are
**values**, never interpolated identifiers. `group_by` and `bucket` are
allow-listed in both the HTTP layer and the SQL layer. Substring search uses a
position-based match so a literal `%`, `_`, or `\` in `q` cannot behave as a
wildcard.

---

## 6. Aggregation

`GET /logs/aggregate` requires `since`, `until`, `bucket`; optional `group_by`.

Resolution strategy:

- **Rollup path** when the filter set is expressible in the rollup's dimensions
  (`service`, `level`): read `logs_agg_1m`, re-bucket to the requested size, sum
  as `BIGINT`.
- **Exact edges.** When `since`/`until` are not aligned to a minute boundary, the
  rollup interior is combined with raw slices for the partial edge minutes.
  A whole edge minute is never counted into a range that does not contain it.
- **Raw path** when `q` or any `attr.<key>` filter is present — those dimensions
  do not exist in the rollup, so the raw table answers.
- Output ordered by bucket start ascending; empty buckets omitted; `group` is
  `null` when `group_by` is absent.

A fast error is not an optimisation. The endpoint always returns a real result.

---

## 7. Resource layout

| Pool | Size | Timeout | Rationale |
| --- | --- | --- | --- |
| write | 2 (1 active flush) | acquire timeout, no statement timeout | Protects the ingest transaction from user-query contention |
| query | 8, tuned in Phase 4 | server-side `statement_timeout` | An abandoned HTTP request does not cancel its PostgreSQL query |
| maintenance | 1 | acquire timeout, no statement timeout | `/health`, migrations, retention must never queue behind user traffic |

Under a single PostgreSQL CPU, a large connection count converts parallelism
into scheduling and memory contention. `work_mem` stays low and is treated as
per-operation, per-backend memory, not a server-wide allowance. The Node heap
cap stays below the cgroup limit with room for native buffers, sockets, and
driver state.

Pool sizing is a **hypothesis to test** (Phase 4 experiment 5), not a result.

---

## 8. Retention

- Configurable via `RETENTION_DAYS` (default 30), parsed strictly — `0` must not
  silently become the default.
- Pre-create monthly partitions across the retention window plus a forward
  margin, ahead of traffic, never from a concurrent insert path.
- Drop a partition only when its entire range has expired.
- Sweep boundary rows and any `DEFAULT`-partition rows in small ordered
  `SKIP LOCKED` batches — bounded transactions, no long locks.
- Apply the same expiry to `logs_agg_1m`, batched per day rather than as one
  large `DELETE`.
- One advisory-locked worker on the maintenance pool.

---

## 9. Configuration surface

Every value is read once in `config.ts` with strict parsing. `Number(x) || default`
is forbidden — it silently replaces `0`, and any garbage, with the default.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `8080` | Spec-fixed |
| `DATABASE_URL` | compose-provided | No hardcoded credentials in the image |
| `SYNC_COMMIT` | `off` | `on` selects the strictly crash-durable profile |
| `RETENTION_DAYS` | `30` | Strict integer |
| `BATCH_DELAY_MS` | `5` | Idle coalescing wait only; a flush always takes the whole queue |
| `QUEUE_MAX_ROWS` / `QUEUE_MAX_BYTES` | `50000` / `32 MiB` | Backpressure trigger |
| `WRITE_POOL_SIZE` / `QUERY_POOL_SIZE` | `2` / `8` | Phase 4 sweep |
| `HOT_ATTRIBUTE_KEYS` | one key | Empty string disables the partial index |
| `READAHEAD_PAGES` | `0` | `0` disables; enabled only if Phase 4 justifies it |
| `BODY_LIMIT` | `4mb` | Documented request cap |
| `CURSOR_SECRET` | generated per start if unset | Never a name that implies anything but its function |

**Zero-config rule (spec §33):** `docker compose up` with no `.env` and no
arguments must produce the plain core service with all four endpoints
unauthenticated. Every optional behaviour is additive and off by default.

---

## 10. Invariants

These hold at every commit. A change that breaks one is reverted, not patched.

1. A `200` from `POST /logs` means those rows are committed and queryable.
2. An invalid entry never rejects a valid sibling.
3. Every SQL value is a bound parameter; every identifier-like choice is
   allow-listed.
4. `next_cursor` is `null` only at the true end of the filtered result set.
5. A cursor timestamp is exactly what PostgreSQL rendered.
6. No client input can produce a `500` or terminate the process.
7. Application memory is bounded by explicit caps, not by hope.
8. Every accepted row is covered by the same retention guarantee.
9. Configuration comments describe the design that exists right now.
10. Every performance claim in the README is reproducible by a script in the
    repository.
