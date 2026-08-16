# Demo video outline — ~5 minutes (T26)

**Purpose:** a scripted walkthrough of the service that covers every spec §44
"demo readiness" topic: architecture, major technical decisions, schema
justification, index justification, `EXPLAIN ANALYZE`, ingestion flow, query
flow, cursor pagination, attribute storage strategy, retention strategy,
bottlenecks, optimisations. Recording is the developer's task; this file is
the outline, the exact commands, and the numbers to show.

**Recording notes**

- Stack: `HOST_PORT=8081 docker compose up -d --build --wait` (use the shipped
  `docker compose up -d --wait` if port 8080 is free on the recording
  machine). Substitute the base URL accordingly in every command below.
- Pre-record, once, so the demo has real data: run the benchmark for ~30 s,
  then a drain with `EXPECT_TOTAL` set — this both seeds ~600k rows and gives
  the numbers quoted below. Figures are from the final run in
  `bench/results/final.md`; substitute your own run's numbers.
- Keep a second terminal pane open for `psql`/`docker compose logs` shots.
- Do not cut between the ingestion request and its response — the point is
  that they are one event.
- Every literal timestamp below is illustrative: align the query/aggregate
  examples with the day you record so the seeded benchmark data falls inside
  the shown ranges.

---

## Timeline

| # | Segment | Time | Covers |
| --- | --- | --- | --- |
| 1 | Opening — what this is | 0:00–0:30 | context |
| 2 | Architecture walk | 0:30–1:30 | architecture, major decisions |
| 3 | Ingestion flow, live | 1:30–2:30 | ingestion flow, group commit |
| 4 | Query + cursor pagination, live | 2:30–3:30 | query flow, cursor pagination |
| 5 | Aggregate, live | 3:30–4:15 | schema justification, attribute strategy |
| 6 | Retention, live | 4:15–4:45 | retention strategy |
| 7 | Performance + EXPLAIN | 4:45–5:30 | bottlenecks, optimisations, EXPLAIN |
| 8 | Close | 5:30–5:45 | recap |

If short on time: trim segment 2 (architecture) to 45 s and fold segment 8
into segment 7.

---

## 1. Opening (0:30)

> "This is a log-ingestion service: TypeScript on Node and Express, PostgreSQL
> 16 underneath. Clients POST batches of logs; the service validates every
> entry, group-commits accepted rows, and answers filtered pages and bucket
> counts. The whole thing runs under 0.5 CPU and 256 MB for the app, 1 CPU and
> 1 GB for PostgreSQL."

One-sentence promise to carry through the video: **a 200 means committed and
queryable.** Close the segment with it.

## 2. Architecture walk (1:00)

Screen: the data-flow diagram from the README (Architecture section), full
screen or in an editor pane.

- Follow a POST from validation → bounded queue → group commit → COMMIT →
  resolve the waiting request. Two beats: *queue is bounded by rows and
  bytes* (full ⇒ 503 + Retry-After), and *the rollup upsert happens in the
  same transaction as the raw rows*, so counts can never diverge.
- Point at the three read paths and the retention worker; one line each.
- Layering: handler → service → repository → SQL; no SQL in a handler, no
  `Request` below the handler.
- **Major decisions to name here (one line each):** group commit instead of
  per-request inserts; `(timestamp, id)` as the primary key *is* the
  pagination index; monthly range partitioning so retention is a partition
  drop; the rollup table for aggregates; three connection pools by role.

## 3. Ingestion flow, live (1:00)

Screen: terminal. Type or run:

```bash
curl -s http://localhost:8080/logs -H 'content-type: application/json' -d '{
  "logs": [
    {"timestamp":"2026-08-16T09:00:00.123456Z","level":"info","service":"checkout","message":"order placed","attributes":{"trace_id":"abc-123","region":"eu-west","attempt":1}},
    {"timestamp":"2026-08-16T09:00:00.200000Z","level":"fatal","service":"checkout","message":"bad level"}
  ]
}'
# → {"accepted":1,"rejected":[{"index":1,"reason":"invalid level: '\''fatal'\''"}]}
```

Talking points while the response is on screen:

- Per-entry validation mirrors **every** database constraint — level enum,
  non-empty service/message, explicit-offset timestamps, flat attributes —
  because one entry that passes JavaScript validation but violates a column
  constraint would abort the whole group-commit transaction and reject its
  valid siblings. The rejection carries the **original array index**.
- The accepted row is enqueued, coalesced with whatever else is in flight
  into one transaction — `COPY` in 64 KiB chunks plus the rollup delta — and
  only then answered. `{"accepted":1}` means committed and queryable.
- Optional 5-second beat: `curl -s http://localhost:8080/metrics` to show the
  batcher's counters (queued rows/bytes, flushes, committed rows).

## 4. Query + cursor pagination, live (1:00)

Screen: terminal, jq-style formatting not required — describe the fields.

```bash
curl -s 'http://localhost:8080/logs?service=checkout&level=info&limit=2'
# → {"logs":[{"id":"599635","timestamp":"2026-08-16T09:00:00.123456Z",...}],
#    "next_cursor":"eyJ2IjoxLCJ0IjoiMjAyNi0wOC0xNlQwOTowMDowMC4xMjM0NTZaIiwi..."}
```

- Every filter combines freely: service, level, since/until, `q` (a literal,
  case-insensitive substring — `strpos`, so `%` and `_` are not wildcards),
  and `attr.<key>` equality.
- Follow the cursor: re-run with `&cursor=<next_cursor>` and note the next
  page starts strictly after the previous page's last row — keyset on
  `(timestamp, id)`, not offset.
- **Why the cursor carries the exact database-rendered timestamp:** the
  column stores microseconds, JavaScript `Date` keeps milliseconds;
  round-tripping through `Date` would silently skip every row sharing a
  millisecond. The payload is signed (HMAC) and bound to a hash of the active
  filters, so a cursor cannot be tampered with or replayed under different
  filters.
- Two quick failure shots (5 s total):
  ```bash
  curl -s 'http://localhost:8080/logs?cursor=not-a-cursor'
  # → 400 {"error":"invalid cursor"}
  ```
- End beat: `next_cursor` is `null` only at the true end — the response probe
  fetches `limit + 1` rows to decide.

## 5. Aggregate, live (0:45)

```bash
curl -s 'http://localhost:8080/logs/aggregate?since=2026-08-16T00:00:00Z&until=2026-08-16T12:00:00Z&bucket=1h&group_by=service'
# → {"buckets":[{"start":"2026-08-16T09:00:00.000000Z","group":"checkout","count":42}, ...]}
```

- Aligned range ⇒ answered from `logs_agg_1m` — a table with one row per
  (minute, service, level) — written **in the same transaction** as the raw
  rows, so the counts you see here are the rows you saw committed earlier.
- Show an unaligned range (shift `since` by a few seconds): the rollup
  interior is combined with **exact raw slices for the partial edge minutes**
  — a whole edge minute is never counted into a range that does not contain
  it.
- `bucket` re-buckets minute granularity into 1m/5m/1h/1d; counts are
  `BIGINT` end to end; empty buckets are omitted.
- **Attribute storage strategy beat:** attributes are JSONB, values keep
  their type; `attr.trace_id=…` uses the partial hot-key index, other keys
  are a documented text-equality scan.

## 6. Retention, live (0:30)

```bash
docker compose exec -T postgres psql -U logger -d logs -c \
  "SELECT relname FROM pg_class WHERE relname LIKE 'logs_%' ORDER BY relname;"
# → logs_2026_06  logs_2026_07  logs_2026_08  logs_agg_1m  logs_default  ...
```

- Monthly partitions, pre-created across the retention window plus a margin —
  so expiry is a `DROP TABLE`, not a mass `DELETE`: no bloat, no long locks.
- Boundary rows (partial months, `DEFAULT`-partition strays) are swept in
  small `SKIP LOCKED` batches, bounded per pass; the rollup table gets the
  same expiry policy, so a dropped partition never leaves stale counts.
- One advisory-locked worker, hourly by default (`RETENTION_DAYS=30`),
  on its own connection pool.
- Optional beat: `docker compose logs api | grep retention_pass` to show a
  real pass line.

## 7. Performance + EXPLAIN (0:45)

```bash
docker compose exec -T postgres psql -U logger -d logs -c \
  "EXPLAIN (ANALYZE, BUFFERS) SELECT logs.id::text AS id,
     to_char(logs.timestamp AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS timestamp_text,
     logs.level, logs.service, logs.message, logs.attributes
   FROM logs ORDER BY logs.timestamp DESC, logs.id DESC LIMIT 1001;"
```

Walk the plan on screen: `Limit` over a `Merge Append` of backward index
scans — **1.6 ms, 34 shared-buffer hits, no sort node**. The primary key
*is* the pagination index; that is the index-justification beat.

Numbers (final run, `bench/results/final.md` — reproducible by the scripts
below; substitute your own run's dataset):

- Ingestion: **21,187 logs/s** sustained over 30 s, 64 workers, batch 200;
  649,600 accepted, 0 errors; whole-batch p50/p95/p99 564/847/915 ms.
- Aggregate p95 **101 ms** concurrent with ingestion (requirement < 1 s).
- Drain: 86.8 pages/s, 86,761 rows/s over 3,001,180 rows; page p50/p95/p99
  9.4/16.1/75.7 ms; 0 duplicates, 0 ordering violations, exact `COUNT(*)`
  match.
- Storage: 1,495 MB at 3 M rows, **514 MB of it indexes** — reported honestly.
- Resources: app ~41–50% of 0.5 CPU, 41–55 MB RSS; PostgreSQL ~45–49% of
  1 CPU, ~327 MB RSS; buffer hit ratio 97.3%.

**Bottlenecks / optimisations beat (the honest one):**

- Fixed defect 1: unqualified `ORDER BY id` resolved to a text alias —
  lexicographic sort vs bigint keyset → rows silently skipped mid-walk;
  measured 18 ordering violations before, 0 after.
- Fixed defect 2: database loss used to crash the process into a restart
  loop; startup now retries with backoff and outages surface as 503.
- Open: page-latency target is ≤ 8 ms p95; measured **26.1 ms**, while
  PostgreSQL does its part in 1.6 ms — the rest is app-side materialisation,
  serialisation, and the HTTP write under 0.5 CPU. The target is missed and
  it is written down as missed.

## 8. Close (0:15)

> "Group commit makes acceptance and queryability the same event; a
> rollup-and-edges aggregate path keeps counts exact; a keyset cursor walks a
> million rows in deterministic order; retention is a partition drop. The one
> number still open is page latency — 16.1 ms against an 8 ms target — and
> that's on the record."

---

## Spec §44 topic coverage check

| Topic | Segment |
| --- | --- |
| architecture | 2 |
| major technical decisions | 2, 7 |
| schema justification | 5, 7 (PK-is-the-index) |
| index justification | 7 (`EXPLAIN`), 5 (hot key) |
| `EXPLAIN ANALYZE` | 7 |
| ingestion flow | 3 |
| query flow | 4 |
| cursor pagination | 4 |
| attribute storage strategy | 5 |
| retention strategy | 6 |
| bottlenecks | 7 |
| optimisations | 7 |

## If asked live: debug / extend

- **Debug an issue** (spec §44): "A user reports pages that skip rows." Path
  to show: reproduce with the drain harness (`npm run bench:drain` with
  `EXPECT_TOTAL` — duplicates/ordering violations fail the run), check the
  plan with `EXPLAIN`, verify the sort columns are table-qualified and the
  cursor carries the DB-rendered timestamp, inspect the batcher metrics via
  `/metrics`.
- **Extend a feature** (spec §44): "Add an index for a new attribute key" —
  set `HOT_ATTRIBUTE_KEYS=trace_id,request_id`, restart; the partial ordered
  index is created at startup, no schema migration needed, and the filter
  `attr.request_id=…` is served from it. Removing the key drops the index.
