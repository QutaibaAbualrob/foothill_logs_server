# Book Optimization Review — overlooked and untouched techniques

> 2026-08-18. Cross-reference of the four local books against the current code
> (`src/`, `docker-compose.yml`, migrations) and the measured results in
> `docs/test_results/`. Purpose: list optimization techniques the books teach
> that this project has **not** implemented or investigated, with the exact
> book location of each, so each item can be judged and picked up
> independently. Paraphrased, with short quotations kept where the books
> state a verdict verbatim; page numbers refer to the printed page numbers of
> the local PDFs.
>
> **Revised 2026-08-18** (same day, after Fastify + Bun became the shipped
> stack and the first PostgreSQL profile landed): the constraint has moved
> **off the application and onto PostgreSQL**, and every ranking below now
> asks one question — *how much PostgreSQL CPU per ingested row does this
> remove?* See the CHANGES section at the end for exactly what moved.
>
> Books: *PostgreSQL 9.6 High Performance* (Ahmed & Smith, Packt, 2017) = **HP**;
> *PostgreSQL for Data Architects* (Maymala, Packt, 2015) = **DA**;
> *Designing Data-Intensive Applications* (Kleppmann, O'Reilly, 2015) = **DDIA**;
> *Database Internals* (Petrov, O'Reilly, 2019) = **DI**.
> The two PostgreSQL books describe 9.3–9.6-era behaviour; every candidate below
> is compatible with PostgreSQL 16, but version-gated claims are marked.

## Legend

- **NEW** — not implemented, and not present in `RND.md`, `plan/`, or any
  results file. These are the items this review exists to surface.
- **KNOWN-UNIMPLEMENTED** — already identified somewhere (mainly RND §6) but
  never built or measured.
- **SPECULATIVE** — book-supported, but no measured workload here exercises
  the query path it would accelerate; it is waiting on a workload, not wrong.
- **MEASURED** — the question the item asked has since been answered by a
  tracked measurement; the item now proposes a follow-up action instead.
- **BOOK-REJECTED** — the book itself advises against the technique; listed so
  it is not re-proposed.
- **CONTEXT** — not a knob; a mechanism the book explains that reframes an
  existing measurement.

The two measurements that set the ranking (both tracked):

- `docs/test_results/postgres-profile.md` — first database profile, taken
  after Fastify + Bun moved the constraint. `COPY` is **71.3%** of database
  time, the cursor page query 28.2%, the rollup upsert 0.2%. PostgreSQL is on
  CPU, not blocked on I/O (186 running samples vs 3 `DataFileRead`, 96.2% heap
  buffer hit ratio).
- `docs/test_results/mixed-workload-baseline.md` + `bench/results/2026-08-18-
  mixed-workload/README.md` — reads measured while writes run. The shipped
  stack: drain 19.6–21.7 pages/s under load, page p95 86–90 ms, aggregate p95
  86–217 ms, 99.6–99.8% visible in 30 s, ingest 14,919–14,989 logs/s, api at
  ~45% CPU and **PostgreSQL at 72–76% with peaks over its own 1.0 cap**.

Statuses were verified against the code: the repository contains no `trgm`,
`BRIN`, `fillfactor`, `INCLUDE`, or HOT-related configuration anywhere.

---

## 1. Write path

The write path owns ~71% of database time, so this is where database-side
optimizations live or die.

### 1.1 HOT updates on `logs_agg_1m` via a lowered table `fillfactor` — NEW (demoted: measured ceiling is 0.2%)

- **Where:** HP pp. 172–173 ("HOT"; the explicit recipe is at the end of
  p. 173: *"One of the ways to make HOT more effective on your tables is to use
  a larger fill factor setting… Having extra empty space available in blocks
  gives HOT more room"*), p. 177–178 (per-table storage parameters),
  p. 242 (index fillfactor mechanics).
- **Why it fits:** the rollup table is updated on **every** ingest flush —
  `ON CONFLICT (bucket_start, service, level) DO UPDATE SET count = count +
  EXCLUDED.count` (`src/ingest/repository.ts`). Only the `count` column
  changes; neither the PK nor `logs_agg_service_bucket_idx` keys change. That
  is exactly the HOT case — *"changes to a row that does not update any of its
  indexed columns"* (HP p. 172). With the default fillfactor (100), pages are
  full, the updated row copy cannot fit on the same page, and every flush
  rewrites entries in **both** indexes plus leaves a dead tuple for vacuum.
  With e.g. `fillfactor=70` on the table (and possibly ~90 on the two
  indexes), updates become HOT: heap-only, no index writes, space reused.
- **Verification the book gives:** HP p. 172 — compare `n_tup_upd` against
  `n_tup_hot_upd` in `pg_stat_user_tables`.
- **Measured ceiling (postgres-profile.md):** the upsert statement is
  **184 ms total across 1,778 calls — 0.10 ms per batch, 0.2% of database
  time**. Eliminating it completely buys 0.2%. Part of the cost is deferred
  into autovacuum and index churn rather than showing up in statement time, so
  0.2% is not a strict ceiling — but `logs_agg_1m` is a small table, so the
  deferred half is bounded too. Keep the item, keep the citation, but do not
  spend a session on it expecting a throughput result.
- **Settling measurement:** one mixed-workload A/B pair; check
  `n_tup_hot_upd` after a short ingest run and watch `pg_cpu_avg`. Expect a
  fraction of a percent, not a headline.

### 1.2 Binary `COPY` format instead of CSV — NEW (promoted: it attacks the 71.3% owner)

- **Where:** HP pp. 282–283 ("COPY FROM"; the chapter documents the command
  and its variants); DDIA p. 142 ("Binary encoding": for internal data one can
  choose *"a format that is more compact or faster to parse"*), pp. 143–147
  (concrete encodings). The wire-format details are PostgreSQL docs, not the
  books.
- **Why it fits — re-argued on the database side.** The original case was the
  app-side `csv()` cost (measured 5.2% of on-CPU time). That half no longer
  matters much: under the shipped stack the application sits at ~45% of its
  0.5 cap, with slack. The half that matters is the one the books justify
  directly: **PostgreSQL parses and validates CSV text for every row, inside
  the statement that owns 71.3% of database time** (`postgres-profile.md`).
  That server-side parse is unmeasured, and it is the only item in this
  review that attacks the dominant cost without giving anything up: no
  durability change, no index change, no query-mix assumption. Binary COPY
  carries a 19-byte signature/trailer, a per-row field-count header, and raw
  bytes for text fields — no quoting or escaping on either side, timestamps
  as int64. The API's JSON contract is unaffected because COPY is already an
  internal format between app and database.
- **Effort / expected effect:** manual framing in a Readable stream
  (`pg-copy-streams`'s `from()` has no binary mode, so it is owned code).
  Medium effort; the size of the win is the unmeasured CSV parse share of
  that 71.3%.
- **Settling measurement:** mixed-workload A/B, binary vs CSV COPY, batch 33
  and 200, watching `pg_cpu_avg` and WAL volume — the only metric that
  isolates the database side of the change.

### 1.3 `wal_buffers = 16MB` — NEW (unchanged; cheap, small)

- **Where:** HP p. 148 (*"in practice write-heavy benchmarks see optimal
  performance at higher values than you might expect… the normal thing to do
  nowadays is to just set wal_buffers=16MB"*); repeated at p. 430 (bulk loads)
  and p. 156 (new-server checklist step 11).
- **Why it fits:** `wal_buffers` is unset in `docker-compose.yml`, so it
  defaults to 1/32 of `shared_buffers` = **8 MB**. This is a write-heavy
  service; the book's recommendation for write-heavy workloads is 16 MB.
- **Effort / expected effect:** one compose line; cost is 8 MB more shared
  memory out of the 1 GB container. Small, safe; measure before claiming a
  number. Given the profile shows PostgreSQL is CPU-bound with a 96.2% buffer
  hit ratio, expect little — take it as a freebie alongside the checkpoint
  change (§1.4), not as its own campaign.

### 1.4 Checkpoint behaviour — MEASURED; now a proposal, not a question

- **Where:** HP pp. 118–119 (dirty-block lifecycle; the full-page-write WAL
  spike after every checkpoint: *"just after a checkpoint, there is a potential
  for write I/O to the WAL to spike, because every page that is dirtied is
  going to get a full page write"*), pp. 120–121 (both checkpoint triggers,
  `log_checkpoints`, `checkpoints_timed` vs `checkpoints_req` in
  `pg_stat_bgwriter`), p. 122 ("Checkpoint spikes"), p. 147 (timeout vs
  size-driven checkpoints and completion-target trade-off).
- **The question is answered** (`postgres-profile.md`): the profile measured
  **859 MB of WAL per 90 s run (~9.5 MB/s), 8,170,369 WAL records, 16,141
  full-page images**, `buffers_checkpoint` 919. At 9.5 MB/s,
  `max_wal_size=2GB` fills in about **3.5 minutes**, so checkpoints are
  **size-driven**, not the 15-minute timeout — exactly the mechanism
  HP pp. 118–122 describes, now with a number. Every one of those checkpoints
  restarts the full-page-write cycle the book warns about, and each
  full-page image is WAL volume inside the CPU-bound write path.
- **Resulting proposal:** raise `max_wal_size` (costs nothing, changes no
  durability property, reduces checkpoint frequency at the measured WAL
  rate). Add `log_checkpoints=on` for the confirmation run.
- **Settling measurement:** one mixed-workload run with
  `log_checkpoints=on` before and after the raise; compare checkpoint lines
  per run and the aggregate p99. If p99 moves, keep it; if not, the setting
  is still free.

### 1.5 Parallel COPY streams — NEW (demoted: the resource is saturated)

- **Where:** HP p. 429 (loading-method ranking: single INSERT < batched
  INSERT < one COPY < *"Multiple INSERT processes using larger blocks in
  parallel"* < *"Multiple COPY processes"*).
- **Why it fits, and why not now:** `WRITE_POOL_SIZE=2` already runs two
  concurrent COPY streams, which is the top of the book's ranking — but the
  pool size was never varied in any run. The caveat in the original version
  of this item ("headroom is doubtful") is now confirmed: **PostgreSQL peaks
  above its own 1.0 CPU cap** under the mixed workload
  (`postgres-profile.md`). Adding writers redistributes a saturated resource
  rather than adding capacity. The book's ranking assumed disk-bound loading;
  this service is CPU-bound.
- **Settling measurement:** only if a future profile shows the database
  dropping below its cap with idle time on the write path. Until then, do not
  schedule this.

### 1.6 Permanently removing zero-scan indexes — NEW (the profile's headline, ranked #1)

- **Where:** HP p. 428 (the bulk-loading chapter scopes its advice — see the
  §5 note for what it does *not* cover); DDIA p. 104 (write amplification:
  *"one write to the database resulting in multiple writes to the disk over
  the course of the database's lifetime"*), p. 107 (every secondary index
  duplicates data and adds write overhead — *"they require additional storage
  and can add overhead on writes"*). The measured side is
  `docs/test_results/postgres-profile.md`.
- **What the profile found:** in the measured run,

  | Index | Size | Scans |
  | --- | ---: | ---: |
  | `logs_2026_08_service_level_timestamp_id_idx` | **116 MB** | **0** |
  | `logs_2026_08_attributes_idx` (GIN) | **57 MB** | **0** |
  | `logs_2026_08_pkey` | 40 MB | 5,095 |

  **173 MB of index maintained on every inserted row, inside the `COPY` that
  owns 71.3% of database time, for zero scans.** `EXPLAIN (ANALYZE, BUFFERS)`
  on the page query shows a `Merge Append` of backward primary-key scans — the
  `(service, level, timestamp DESC, id DESC)` index is never consulted, and
  neither is the attribute GIN. Each maintained index is per-row CPU in the
  dominant statement plus its share of the 9.5 MB/s WAL stream.
- **State the limit honestly (as postgres-profile.md does):** this workload's
  reads are an *unfiltered* cursor walk plus aggregates. It never filters by
  `service`, `level`, or an attribute. The indexes are therefore **pure write
  cost under this query mix — not proven useless.** Migration `002`'s own
  comment records the GIN taking an attribute lookup from ~158 ms to
  ~0.4 ms. So this is a trade to measure, not a cleanup: dropping or
  narrowing them makes the write path cheaper in the component that is now
  the constraint, at the cost of the filtered read paths.
- **The middle option:** replace the whole-bag `jsonb_path_ops` GIN with a
  narrow partial expression index on specific hot keys.
  `HOT_ATTRIBUTE_KEYS` and `ensureHotAttributeIndexes` in
  `src/db/migrate.ts` already implement this — it is configuration, not new
  code. This also engages with migration `002`'s `fastupdate = off` reasoning,
  which is the best-argued comment in the repo: it shows the GIN pays its way
  only when reads keep pace with writes. The profile shows that, in the
  measured mix, the reads are not happening at all.
- **Settling measurement (postgres-profile.md Next 1–2):** mixed-workload
  runs with each index dropped/narrowed — write gain at batch 33 and 200
  *and* read cost with a service-filtered walk
  (`DRAIN_FILTERS=service=checkout`) and an attribute-filtered walk. Both
  halves must be measured; a write gain alone is not a decision.

### 1.7 Background-writer tuning — NEW (a book chapter this review missed)

- **Where:** HP pp. 123–124 (`buffers_backend` and `buffers_clean`
  definitions: a backend *"must write the dirty block out itself before it
  can use the buffer page"*; the background writer writes dirty, low-usage
  blocks pre-emptively), pp. 339–346 (`pg_stat_bgwriter` monitoring and the
  iterative tuning method: snapshot, change one knob, compare the direction
  of `buffers_clean` vs `buffers_backend`), with the caution at p. 210 that
  making the background writer more aggressive *"usually results in a net
  loss in raw throughput… without improving latency either"* — the direction
  of the tuning is not a given.
- **What the profile found:** `buffers_backend` **38,055** against the
  checkpointer's **919** and the bgwriter's **18,238**
  (`postgres-profile.md`). Writer backends are stalling to find clean buffers
  instead of the background writer staying ahead of them.
  `bgwriter_lru_maxpages` / `bgwriter_delay` are untouched defaults and have
  never been measured here.
- **Settling measurement:** a `pg_stat_bgwriter` snapshot pair plus one
  mixed-workload run with a raised `bgwriter_lru_maxpages`; HP p. 210's
  warning means the result could go either way — measure, do not assume the
  knob helps.

---

## 2. Read path

The read path is now the healthy side of the ledger: 7.4–8.9 ms per 1,000-row
page, 96.2% buffer hit ratio, and 28% of database time
(`postgres-profile.md`). Items in this section are judged against that.

### 2.1 BRIN index on `timestamp` — NEW, downgraded to SPECULATIVE

- **Where:** HP pp. 245–246 ("BRIN": *"intended to accelerate scans of very
  large tables, without the maintenance overhead of B-trees… maintain
  'summary' data about block ranges… all pages in the range are returned in a
  lossy TID bitmap if the quals are consistent with the values in the summary
  tuple"*).
- **Why it fits:** the two scan-based read paths — `q` substring search and
  attribute filters with `jsonb_path_ops` — are sequential scans over whole
  partitions (`src/query/builder.ts`). A BRIN index on `timestamp` would turn
  time-bounded scans into bitmap scans over matching block ranges at nearly
  zero write cost.
- **Speculative because:** **no measured workload here exercises `q` at all**,
  and `HOT_ATTRIBUTE_KEYS` is empty in the shipped compose file, so the
  ordered partial-index path has never been exercised either
  (`postgres-profile.md` Next 4). Both scan paths the index would accelerate
  are currently unmeasured, possibly unused. Keep the item; do not schedule it
  ahead of §1.6's filtered-walk measurements, which would justify it.
- **Settling measurement:** a `q`-filtered and an attribute-filtered mixed
  run; if those appear in the workload, `EXPLAIN (ANALYZE, BUFFERS)` before
  and after, plus `pg_stats.correlation` for `timestamp` (append-order
  correlation is the precondition).

### 2.2 Covering index / index-only scans — moved to §5 (measured out)

Rejected with measurements, not arguments: the page query is already 38
buffers hit / 0.57 ms for 1,000 rows, and the cure doubles index size on the
write path that owns 71% of database time. See §5.

### 2.3 Session-level `work_mem` for the aggregate path — NEW (kept; gated on §3.2)

- **Where:** DA pp. 49–50 ("Sorting in memory with work_mem": per-session
  raise for cases where *"the data volume to be handled is going to be high
  and still we need a short response time"*; the `pg_stat_database`
  `temp_files`/`temp_bytes` recipe that proves a sort spilled); HP p. 152
  (*"increase sort memory for the clients that you know are running large
  reports"*), pp. 300–301 (sizing formulas: `RAM / max_connections / 4` is
  aggressive, `/ 16` safe; `log_temp_files` shows every spill).
- **Why it fits:** `work_mem=4MB` globally. The raw aggregate path
  (`aggregateRaw`, plus the two edge-slice queries in the rollup path) groups
  an arbitrarily wide range by `(bucket, group)` — over a month of rows that
  sort/hash can spill to temp files, and temp-file I/O lands exactly in the
  aggregate p95 the mixed-workload harness measures.
- **Gate, unchanged:** **nothing has ever looked at `temp_bytes` in this
  repository.** §3.2 is the diagnostic; until it proves a spill, this item
  must not be tuned — the rollup path answers most ranges from `logs_agg_1m`,
  so the raw path's spills may already be rare.
- **Settling measurement:** `log_temp_files=1MB` during a mixed run; if (and
  only if) spills appear, `SET LOCAL work_mem = '16MB'` on the read pool for
  aggregate queries (8 backends × 16 MB worst case ≈ 128 MB of the 1 GB
  container) and re-measure aggregate p95.

### 2.4 Per-column statistics targets — NEW, downgraded to SPECULATIVE

- **Where:** HP pp. 297–298 ("Statistics targets", "Adjusting a column
  target": raise per column, not globally, since large targets *"incur
  overhead on every query that is planned"*; "Difficult areas to estimate":
  where the planner has no statistics it falls back to crude guesses);
  DA pp. 151–152 (same rule, with the *"EXPLAIN ANALYZE shows a significant
  variation between the actual and estimates"* trigger).
- **Why it fits:** the predicate builder rewrites `q` as
  `strpos(lower(message), lower($n)) > 0` — an expression the planner cannot
  estimate, so it uses the book's default-selectivity guess; attribute
  filters combine a containment OR with a recheck. If mixed-workload plans
  ever show row-count misestimates flipping the scan/index choice, the book's
  remedy is raising `SET STATISTICS` on the specific columns, not touching
  `enable_*` (see §5).
- **Speculative because:** the query mixes that would show the misestimates —
  `q` and attribute filters — have never been run in any measured workload.
  Diagnostic-only until a bad estimate is observed.

### 2.5 `CLUSTER` for timestamp correlation — NEW, downgraded to SPECULATIVE

- **Where:** HP pp. 241–242 ("Clustering an index": rewrites the table in
  index order; *"useful for getting faster results from range-based queries"*;
  one-time — *"future insertion does not respect the clustered order"*),
  p. 416 (partitioning makes per-partition maintenance practical).
- **Why it fits:** COPY appends in commit order, not timestamp order;
  out-of-order client timestamps and two interleaved writers degrade the
  correlation that BRIN (§2.1) and range scans depend on. Because partitions
  are monthly and retention drops whole partitions, a one-time CLUSTER on
  each partition while it is still young is cheap and bounded.
- **Speculative because:** it exists only as a companion to §2.1, which is
  itself waiting on a workload that exercises the scan paths. Book-stated
  cost is an exclusive lock and a full rewrite — do not take it for a
  correlation improvement that no query needs yet.

### 2.6 Trigram GIN for message substring search — KNOWN-UNIMPLEMENTED, downgraded to SPECULATIVE

- **Where:** HP p. 251 ("Indexing for full-text search": *"GIN is better
  suited for relatively static data, while GiST performs better with
  frequently updated"* indexes), p. 244 (GIN mechanics), p. 243 (B-tree
  `text_pattern_ops` cannot match mid-string — why a plain B-tree on
  `message` does not answer `q`).
- **Status:** RND §6 lists `pg_trgm` as a candidate to benchmark; the shipped
  schema has no message index and the compose comment says a `q` search is a
  scan by design. The book's GiST-vs-GIN guidance stands: a continuously
  ingested log table is the *frequently updated* case, so a GiST trigram
  index is the book's first pick, at the cost of larger size and slower exact
  lookups than GIN.
- **Speculative because:** **no measured workload exercises `q`.** An index
  whose read benefit no measured query uses, in a write path that owns 71% of
  database time, is precisely the §1.6 pattern — the write cost must be
  justified by a measured read demand first (GIN attributes precedent:
  ~4.5% ingest, migration 002).

---

## 3. Operations and observability

### 3.1 "Unexplained writes" on the read path — CONTEXT (now measured, not predicted)

- **Where:** HP p. 435 ("Unexplained writes": reads of recently committed
  rows write **hint bits** into the data pages until every page has been
  visited once; plus *"if your query is doing a sort operation… that will
  cause writes too"*), p. 323 (TOAST I/O counters), p. 118 (dirty-page
  writeback).
- **Why it matters — confirmed:** the predicted read degradation under
  concurrent ingest is now measured (`docs/test_results/mixed-workload-
  baseline.md`): under Express the reader was starved for ~15 s stretches and
  only 14.5–15.3% of accepted rows were visible in the window; under the
  shipped stack visibility is 99.6–99.8%. The mechanism remains worth knowing
  for any future regression: the first pass over freshly written pages is
  unusually expensive (hint-bit writes + cold pages), which is why warm-up
  effects must be controlled for when comparing runs.

### 3.2 `log_temp_files` — NEW (unchanged; now the explicit gate on §2.3)

- **Where:** HP p. 300 (*"you can turn on log_temp_files and see all the cases
  where work_mem was not large enough, and the external merge Disk sort is
  used instead"*); DA pp. 49–51 (the `pg_stat_database` recipe).
- **Why:** the cheapest possible check on whether the aggregate path spills.
  Nothing in this repository has ever looked at `temp_bytes`. Add
  `log_temp_files=1MB` next to `log_checkpoints` (§1.4) for measurement runs.
  Until it shows a spill, §2.3 stays untuned.

### 3.3 `pg_stat_statements` and `auto_explain` — ALREADY-BUILT (half) / NEW (half)

- **Where:** HP p. 195 (`auto_explain`: plans of slow queries, incl. buffer
  counts), p. 197 (`pg_stat_statements`: per-statement totals), pp. 227–239
  (the book's own walkthrough of reading block statistics from EXPLAIN).
- **Status correction:** `pg_stat_statements` is **already built and used** —
  `bench/raw/pgprof.override.yml` enables it plus `track_io_timing=on`, as a
  measurement-only override so the shipped compose file is untouched
  (`docs/test_results/postgres-profile.md` is its output). `auto_explain` is
  genuinely still unused; keep that half. Monitoring-only; no production
  behaviour change.

### 3.4 Closed-loop load generation hides the backlog — CONTEXT (the book stated the rule first)

- **Where:** DDIA p. 18 ("Describing Performance", the paragraph on
  generating load artificially): *"the load-generating client needs to keep
  sending requests independently of the response time. If the client waits
  for the previous request to complete before sending the next one…"* — the
  same page also instructs measuring response times on the client side.
- **Why it matters:** this is the clearest case in this review of a book
  stating in advance a rule this project had to rediscover by being burned.
  `scripts/benchmark.mjs` is closed-loop — workers send, await, then send
  again — so when the server slowed, offered load fell with it, no backlog
  ever formed, and the read-path collapse under concurrent ingest stayed
  invisible. `scripts/mixed-workload.mjs` exists precisely to break that; its
  two load-bearing properties (open-loop dispatch against a wall clock,
  visibility measured while writes continue) are the book's rule implemented,
  and `bench/results/2026-08-18-mixed-workload/README.md` names both as
  load-bearing. Client-side timing is the harness's practice too.

---

## 4. Cross-cutting concepts from DDIA and Database Internals

- **The constraint moved.** `docs/test_results/postgres-profile.md`: under
  Express + Node the app was pinned at its cap while PostgreSQL idled at
  28–33%; under the shipped stack the api sits at ~45% and PostgreSQL carries
  72–76% with peaks over its own cap. Everything below and in §6 is ranked on
  that fact.
- **Write amplification, measured style.** DDIA p. 104: a B-tree write is
  never a single write — WAL plus page, again on split; *"one write to the
  database resulting in multiple writes to the disk"*. The profile gives the
  local instance: 9.5 MB/s of WAL, 16,141 full-page images, and two indexes
  of 116 MB and 57 MB maintained inside the dominant `COPY` for zero scans
  (§1.6). Every index added on the ingest path must be justified with the
  same discipline migration 002 applied (measured ~4.5% for GIN).
- **Rollup = data cube — now with measured confirmation.** DDIA pp. 125–126
  ("Aggregation: Data Cubes and Materialized Views"): the `logs_agg_1m`
  design is the book's data cube, maintained correctly (same-transaction
  updates, DDIA p. 473's "derived data" section; HP p. 440's
  materialized-view section as the 9.6-era ancestor). The profile vindicates
  it: **aggregates cost 0.2% of database time because they read `logs_agg_1m`
  rather than raw rows** — 7,005 index scans on its primary key — and the
  write-side maintenance is 0.10 ms per batch (`postgres-profile.md`). The
  book's big read-path optimization was the right call.
- **The hot partition.** DDIA p. 245: with timestamp-range partitioning
  *"all the writes end up going to the same partition (the one for today)"*.
  Confirmed in the profile: 1,349,964 rows all into `logs_2026_08`, where
  reads and writes collide on the same pages.
- **Row store vs column store.** DDIA pp. 118–124: column layout, bitmap
  encoding, run-length compression and vectorized scans explain *why* raw
  aggregation over a row-store is slow and why the rollup is the right answer
  at this scale. A columnar/LSM engine (TimescaleDB-style) is out of scope
  for the fixed `postgres:16.4` image and the 1 GB envelope.
- **B-tree right-side appends.** DI pp. 71–72: monotonic keys make most
  splits happen on the rightmost leaf — the mechanism behind the identity
  BIGINT choice (already implemented, RND §7). Also DI p. 75 on dead-tuple
  accumulation and garbage collection: the B-tree analogue of why §1.1's HOT
  tuning is bounded on the small rollup table.

---

## 5. Techniques the books reject (or that don't apply here)

These are listed so they are not re-proposed; the books themselves argue
against them in this setting.

| Technique | Book verdict | Location |
| --- | --- | --- |
| `fsync=off` | Dangerous; *"unambiguously dangerous setting to disable"*; `synchronous_commit=off` is the sanctioned trade | HP p. 153 |
| `full_page_writes=off` | Corruption risk unless filesystem is proven immune to torn pages | HP p. 154 |
| `commit_delay` / `commit_siblings` | *"not effective parameters to tune in most cases"* | HP p. 154 |
| `COPY … FREEZE` | Requires table created/truncated in the same transaction — initial load only, violates MVCC visibility | HP p. 283 |
| WAL-skipping bulk load (`CREATE TABLE` + `COPY` in one transaction) | Same condition; impossible for a live append API | HP p. 431 |
| `pg_bulkload` | Fast because it skips shared buffers and WAL; needs a separate recovery path — offline loading only | DA pp. 171–172 |
| `UNLOGGED` tables | **The trade, priced** — see the note below the table. Removes WAL work entirely rather than reordering it: the largest write-path lever on the durability spectrum. Not a book recommendation: DA describes the mechanism and names the compromise; HP does not tune it at all | DA p. 61; HP p. 455 (release history only); `plan/00-MASTER-PLAN.md`; RND §9.1 |
| **Temporarily** dropping indexes or disabling autovacuum *around an initial bulk load, to rebuild after* | Explicitly for initial population — *"not applicable"* to incremental loading into live tables | HP p. 428, p. 430 |
| **Permanently** removing an index that takes zero scans in steady state | **Not the same case as the row above, and not foreclosed by it.** The book's bulk-load advice is about temporary drop/rebuild around one load; it says nothing about removing an index no steady-state query consults. That is §1.6, measured, and the current highest-leverage candidate | §1.6; `docs/test_results/postgres-profile.md` |
| Covering index with `INCLUDE (message, attributes)` for the page query | **Rejected by measurement.** `EXPLAIN (ANALYZE, BUFFERS)` shows the page query served by backward PK scans: 38 buffers hit, 0.57 ms for 1,000 rows, at a 96.2% heap hit ratio — the heap access an index-only plan would eliminate is already close to free. The premise that the drain is application-limited was true of Express and is **not** true of the shipped stack (agents.md Next 1). The cure roughly doubles index size on the write path that owns 71% of database time: the book's general covering-index advice (HP pp. 247–248, DDIA p. 107) points the wrong way for this specific workload | HP pp. 247–248; DDIA p. 107; `docs/test_results/postgres-profile.md` |
| Hash indexes | *"You normally shouldn't ever use the hash index type"* — **version-gated.** The book's reason is that hash indexes were easy to corrupt after a crash and then ineffective until manually rebuilt. PostgreSQL 10 made hash indexes WAL-logged and crash-safe, which removes the basis of the verdict. For the equality-only partial hot-key index proposed in §1.6, a PostgreSQL 16 hash index is smaller and cheaper to maintain than a B-tree — that option is open, not rejected | HP p. 244 (9.6-era verdict); §1.6 |
| `enable_seqscan=off` and friends | *"Generally, this is a bad idea"* — fix statistics instead (see §2.4) | HP p. 155; DA p. 156 |
| pgBouncer | *"If you have hundreds or thousands of connections…"* — this service runs 10 pooled connections against a 1-CPU server; a pooler adds a hop, not capacity | HP p. 382, p. 378 |
| Named prepared statements to cut parse cost | They force generic plans that can ignore per-value selectivity — *"this isn't necessarily true [that PREPARE is a win]"*; unnamed statements (what `pg` uses) re-plan | HP pp. 436–437 |
| `REFRESH MATERIALIZED VIEW` pattern | Superseded by the same-transaction rollup upsert already built (stale-window refresh vs exact minute rollup) — §4's measured confirmation | DA pp. 157–160; HP p. 440 |
| `random_page_cost`/`effective_cache_size` re-tuning | Already at the book-recommended SSD/dedicated values (1.1 / 768 MB); HP's dedicated-server checklist matches the current compose | HP pp. 150–156, DA pp. 153–154 |
| BRIN/B-tree misuses | B-tree text index cannot match mid-string `q` (HP p. 243) — that is why §2.6's trigram index is the only `q` option | HP p. 243 |

**UNLOGGED tables — the trade, priced.** `CREATE UNLOGGED TABLE` exists for
exactly this shape of problem: DA p. 61 presents it for tables one wants
*"fast to insert/update"* while *"willing to compromise on durability"*. The
compromise is not small — an unlogged table's data is not written to WAL at
all, and an unclean restart **truncates it**; that truncation is the reason
`plan/00-MASTER-PLAN.md` records the project as not using them. It removes
the largest per-row cost in a database whose dominant statement is 71.3%
`COPY` — and it voids the acknowledged-row durability contract the service's
own gates verify (RND §9.1: unlogged tables cannot sit under a "200 only
after a durable commit" guarantee). HP has no tuning discussion of unlogged
tables; its only mentions are release-history notes (pp. 455–456). The books
therefore bound the trade but do not resolve it, and the repo's tracked
policy currently resolves it as a rejection. Whether the write-side price is
worth paying is the owner's decision; this document's job is to keep the
lever visible and the price explicit.

---

## 6. Suggested order of attack — ranked by measured PostgreSQL CPU per row

Ranking rule: **how much PostgreSQL CPU per ingested row does the item
remove, and how much does it risk?** The constraint is database CPU
(`postgres-profile.md`), not application CPU and not disk I/O. Items that
spend database write cost to buy read speed are now net-negative until a
workload proves the read demand; items that target the application are aiming
at the resource with slack. The settling measurement for every performance
item is the same harness: `scripts/mixed-workload.mjs` (`npm run bench:mixed`),
interleaved and repeated per the seven-rule standard in agents.md.

1. **§1.6 Index removal / narrowing** — the only item that directly reduces
   per-row work in the 71.3% statement. Settle with: mixed-workload A/B, each
   index dropped one at a time — write gain at batch 33 and 200, *and* read
   cost with `DRAIN_FILTERS=service=checkout` plus an attribute-filtered
   walk.
2. **§1.2 Binary COPY** — attacks the unmeasured server-side CSV parse inside
   the same 71.3% owner, giving up nothing. Settle with: mixed-workload A/B
   (binary vs CSV), watching `pg_cpu_avg` and WAL volume.
3. **§1.7 Background writer** — a measured imbalance (`buffers_backend`
   38,055 vs bgwriter 18,238) in a resource that is provably the constraint.
   Settle with: `pg_stat_bgwriter` snapshots + one mixed run with a raised
   `bgwriter_lru_maxpages`; HP p. 210 warns the direction may go either way.
4. **§1.4 Checkpoint** — measured 9.5 MB/s WAL makes checkpoints size-driven
   at ~3.5 minutes; raising `max_wal_size` is free. Settle with:
   `log_checkpoints=on` run before/after; watch aggregate p99.
5. **§3.2 then §2.3 work_mem** — diagnostic before knob; nothing has ever
   looked at `temp_bytes`. Settle with: `log_temp_files=1MB` in a mixed run;
   tune only if a spill appears.
6. **§1.1 HOT/fillfactor** — keep the citation and the recipe, but the
   measured ceiling is 0.2% of database time; expect a fraction of a percent.
   Settle with: `n_tup_hot_upd` after one ingest run.
7. **§1.3 wal_buffers** — one compose line, small effect at a 96.2% buffer
   hit ratio; take as a freebie, never as a campaign.
8. **§2.1 / §2.4 / §2.5 / §2.6 (BRIN, statistics targets, CLUSTER, trigram)** —
   all speculative until a workload exercises `q` or attribute filters; none
   of them has any measured read demand to serve. Do not schedule before §1.6
   produces the filtered-walk numbers.
9. **§1.5 Parallel COPY** — last: the database peaks above its own cap, so
   more writers redistribute saturated CPU. Revisit only if the constraint
   moves again.

---

## 7. The read/consistency side — ranked by a different question

§6 ranks by *database CPU per ingested row*, which is the right question for
the write path that owns 71.3% of database time. The items below answer a
different question — *which consistency guarantees does the read side offer,
and which of them have never been measured?* They are ranked by how directly
they bear on the read-side acceptance checks, not by write-path cost.

### 7.1 Read-after-write consistency — the guarantee the ingest queue threatens

- **Where:** DDIA pp. 197–199 ("Reading Your Own Writes", in the
  replication-lag discussion): read-after-write — also called
  read-your-writes — is a *named* guarantee: *"if the user reloads the page,
  they will always see any updates they submitted themselves"*. The book's
  implementation strategies (read recently-modified data from the leader;
  track a last-write timestamp client-side; refuse or wait on reads from
  sources that have not caught up) all exist to close a lag between
  *accepted* and *visible*.
- **The mapping:** this service has the same structure one layer down. The
  bounded queue in `src/ingest/batcher.ts` sits between `POST /logs` and row
  visibility; a batch is acknowledged only after commit, but a reader can
  still lag behind the commit point by queue delay plus its own polling
  interval. The queue plays the role of replication lag, and the anomaly is
  identical: a client that posts and immediately queries can see its own rows
  missing.
- **What is measured:** per-request read-after-write at the shipped stack,
  under sustained load, is **not** measured by any current harness —
  `scripts/mixed-workload.mjs` measures cohort *visibility inside a window*
  (99.6–99.8% under the shipped stack, `docs/test_results/mixed-workload-
  baseline.md`), which is the same anomaly family at batch scale but not a
  write-then-read-the-same-row probe. The only 1:1 read-after-write numbers
  in the repo predate the stack swap (`README.md`, "Mixed workload": an
  attribute lookup after every accepted POST, 0.4% → 100% found after the GIN
  work). `plan/05-BENCHMARK-PROTOCOL.md` requires read-after-write probing;
  the per-request form of it still has no harness home. A documented absence
  is a result: the guarantee the read-side acceptance checks are built on has
  never been probed in the exact form the checks exercise.
- **Read-side item (rank 1):** add a per-request read-after-write probe mode
  to the mixed-workload harness — after each accepted batch, query for one of
  its own rows and record found/not-found plus latency. Settling measurement:
  the probe itself, run at the shipped stack under sustained load. This is
  the book's guarantee measured against the queue, and it is the most direct
  evidence available for the read-side acceptance dimension.

### 7.2 Monotonic reads across a growing table — one sentence plus one gate

- **Where:** DDIA pp. 200–201 ("Monotonic Reads"): with reads spread across
  sources of differing lag, a user can see *"time go backward"* — a row
  appears, then disappears on the next read. The guarantee is that one
  reader's successive reads never move backward; the book's fix is routing
  one user's reads to one source.
- **The mapping:** cursor pagination (`(timestamp DESC, id DESC)` keyset) over
  a table that is being appended to while the client pages through it is
  exactly the shape where backward movement shows: pages minted from a
  snapshot can repeat or skip rows as new writes land mid-walk. The drain
  correctness gate (ordering, duplicates, true end) is effectively a
  monotonic-reads test *at rest*; it has never been run with writes flowing.
- **Read-side item (rank 2):** one drain-walk correctness pass under
  concurrent ingest — the mixed-workload harness already walks while writes
  run, so assert ordering and duplicates on that walk, not only on the idle
  one. Settling measurement: the walk's duplicate/ordering counters while
  ingest holds the target rate.

---

## CHANGES

- 2026-08-18: created. Original cross-reference of the four books against the
  code as it stood pre-merge; §1.1 ranked first and §1.4 asked for a
  checkpoint measurement that did not exist yet.
- 2026-08-18 (revision, same day): re-ranked after Fastify + Bun became the
  shipped stack (`5dc962c`) and the first PostgreSQL profile landed
  (`4c41922`). The profile moved the constraint onto PostgreSQL (`COPY`
  71.3%, database at 72–76% CPU with peaks over its cap, CPU-bound with a
  96.2% buffer hit ratio), which flips the ranking metric to database CPU per
  ingested row. Specific changes: §1.1 demoted with its measured ceiling
  (0.2%); §1.2 re-argued on the unmeasured server-side CSV parse inside the
  dominant statement and promoted; §1.4 closed — 859 MB WAL/90 s ≈ 9.5 MB/s
  makes checkpoints size-driven at ~3.5 minutes, so the item is now a free
  `max_wal_size` raise; §1.5 demoted (saturated CPU); §2.2 moved into §5
  (page query measured at 38 buffers hit / 0.57 ms; the cure doubles index
  size on the 71%-owner); §2.1/§2.4/§2.5/§2.6 marked speculative (no measured
  workload exercises `q`; `HOT_ATTRIBUTE_KEYS` ships empty); §3.1's
  prediction confirmed by `docs/test_results/mixed-workload-baseline.md`;
  §3.3's `pg_stat_statements` status corrected to already-built
  (`bench/raw/pgprof.override.yml`); two items added — §1.6 permanent removal
  of zero-scan indexes (173 MB maintained for zero scans, with the honest
  untested-not-useless limit) and §1.7 background-writer tuning (38,055
  backend writes vs 18,238 bgwriter); §5's temporary-drop row split from the
  new permanent-removal case; §4's rollup bullet gained its measured
  confirmation (0.2% of database time for all aggregates).
- 2026-08-18 (second revision): added the read/consistency side the earlier
 revisions lacked — §7 maps DDIA's read-after-write guarantee ("Reading Your
 Own Writes", pp. 197–199) and monotonic reads (pp. 200–201) onto the ingest
 queue and the cursor walk, states which forms have never been measured
 (per-request probing has no harness home; the nearest tracked proxies are
 window visibility in `docs/test_results/mixed-workload-baseline.md` and the
 pre-swap 1:1 lookup numbers in `README.md`), and ranks the two resulting
 read-side items under their own question rather than §6's write-path rule;
 §3.4 records DDIA p. 18's closed-loop rule as the book citation behind
 `scripts/mixed-workload.mjs`'s two load-bearing properties; §5 gains the
 UNLOGGED trade priced against tracked evidence (DA p. 61 names the
 mechanism and the compromise; HP mentions it only in release history,
 pp. 455–456; `plan/00-MASTER-PLAN.md` prices the truncation) and
 version-gates the hash-index row (PostgreSQL 10 made hash indexes
 WAL-logged and crash-safe) with a cross-reference to §1.6; the header's
 quoting line is reconciled with the short quotations actually used.
