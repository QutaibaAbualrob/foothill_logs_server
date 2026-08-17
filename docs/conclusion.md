# Verification conclusion

**Date:** 2026-08-16

**Base revision reviewed:** `7bd338e5abfd71e9f31f3e62ad35f63c7f0fe967`

**Corrections verified:** included in this revision
**Scope:** repository contents, local tests, the preserved Compose stack,
benchmark evidence, pushed GitHub state, CI, a disposable clean-clone boot,
and the post-review corrections listed below.

This verification was performed from files, command output, live HTTP
responses, raw captures, Git history, and the GitHub API. Prior status reports
were not treated as evidence. Service code was changed only after evidence
collection identified the precision defect. The smoke and failure-drill
commands did ingest verification rows into the preserved database; its volume
was never removed.

## Conclusion

The service's operational correctness is substantially supported. TypeScript
type-checking passed; all unit tests and both PostgreSQL integration tests ran
successfully; the contract smoke and 73-case reliability suite passed; and the
failure drill proved database-outage degradation, recovery without an
application restart, graceful repeated `SIGTERM`, and exact equality between
client-acknowledged rows and the database delta. A fresh remote clone built and
became healthy on port 8083, and GitHub CI was green on the reviewed revision.

The recorded evidence is not fully sufficient for every published claim.
The retained raw files do not contain the ingestion or drain console summaries
behind the headline final numbers, and the retained resource CSV contains two
headers and samples spanning multiple capture attempts. Those measurements
remain run records, not independently reconstructible raw evidence.
Freshness has a strong committed-before-acknowledgement design argument, but no
recorded delay distribution, so the numeric freshness gate is unverified.

All three query-performance targets were missed. The full cursor walk
was correct but took 34.6 seconds rather than fitting inside the 30-second
window; 86.8 pages/s was below the ≥100 pages/s target. Page p95 was 16.1 ms
against ≤8 ms, and concurrent aggregate p95 was 101 ms rather than
double-digit milliseconds. The aggregate still meets the specification's
<1-second requirement.

One API precision defect was found and corrected locally. `since` and `until`
accept up to nine fractional-second digits, so their ordering is now compared
as exact epoch nanoseconds instead of millisecond-resolution `Date.parse`
values. The reversed range `since=...000002Z&until=...000001Z` now returns
HTTP 400, and both query parsers have a regression test. The edge-slice
algorithm itself passed its existing tests plus 9,902 independent valid-range
property checks.

## Claim disposition

| Area | Result | Evidence summary |
| --- | --- | --- |
| Edge slices, retention, shutdown code | Pass | Implemented and exercised; exact bound ordering now has unit and live HTTP coverage |
| Typecheck and tests | Pass | Typecheck exited 0; 23/23 tests passed with PostgreSQL; integration files skipped cleanly without it |
| Contract and reliability scripts | Pass | Smoke passed; reliability passed 73/73 |
| Failure drill | Pass | `db +201400 = accepted 201400`; final health 200 |
| Benchmark provenance | Fail | Headline ingestion/drain outputs absent from `bench/raw/`; resource CSV is concatenated |
| Query-performance targets | Fail | 34.6 s drain, 86.8 pages/s, 16.1 ms page p95, and 101 ms aggregate p95 miss the plan targets |
| EXPLAIN evidence | Pass | Page and aggregate captures contain actual timing and buffer data |
| README evidence consistency | Partial | Required structure exists; evidence and freshness qualifications required correction |
| Repository hygiene | Partial | Current-tree wording required cleanup; earlier patch content remains retrievable from public history |
| Remote and CI | Partial | `main` and CI correct; remote history contains 13 commits, not 7 |
| Clean-clone boot | Pass | Fresh remote clone returned HTTP 200 and was then removed with its disposable volume |

## Evidence limits

- `bench/results/*.md` preserves run summaries, but the exact final
  ingestion, drain, and E1+E2 console outputs were not retained under
  `bench/raw/`.
- `bench/raw/final-load-summary.json` records storage, WAL, and buffer-hit
  fields, but the old capture script queried only the partitioned parent for
  relation and index size. PostgreSQL reports zero bytes for that parent, so
  the recorded partition totals cannot be reconstructed from the script or a
  retained raw SQL result. The corrected script walks `pg_partition_tree` and
  emits exact byte counts.
- `bench/raw/final-load-resources.csv` contains headers at lines 1 and 44 and
  spans 397.26 seconds, so it cannot be treated as one clean 40- or 60-second
  sampling window.
- The historical "18 ordering violations before, 0 after" measurement is
  recorded in `plan/HANDOFF.md`, not in a retained raw capture.
- Earlier public commits contain evaluation-oriented wording in patch history.
  Editing the current tree does not remove it from `git log -p`; clearing that
  exposure requires an explicit history-rewrite and force-push decision.

## Corrections applied after review

- The drain harness now treats `withinDeadline: false` as a hard failure, even
  if the final page eventually reaches the true end.
- Timestamp bounds are compared at the full accepted nanosecond precision;
  unit and live reliability regressions reject reversed sub-millisecond ranges.
- Benchmark and drain summaries support create-only `RESULT_PATH` output.
  Resource capture refuses reused run names, records actual timing/sample
  counts, and measures partitioned-table and index sizes across the complete
  partition tree.
- The final benchmark and README now distinguish pagination correctness from
  missing the 30-second drain window and record all three missed query targets.
- Fixture-specific historical narrative was removed from the current tracked
  handoff. Public patch history was not rewritten.

## Required follow-up

1. Re-run the 3 M-row drain with the corrected hard deadline; reaching the true
   end must take at most 30 seconds and requires at least 100.1 pages/s for this
   dataset.
2. Continue page and aggregate profiling until the ≤8 ms page p95 and
   double-digit aggregate p95 targets are met, or keep both recorded as misses.
3. Repeat the final ingestion, drain, and resource captures with unique run
   names; retain the complete machine-readable outputs without appending
   multiple attempts to one CSV.
4. Measure read-after-write freshness as a delay distribution before marking
   the freshness performance gate complete.
5. Decide whether to rewrite and force-push public history to remove the
   historical contextual wording, or explicitly accept that it remains
   recoverable. Do not rewrite history implicitly.
6. Treat the published performance figures as recorded rather than
   independently verified until those raw captures exist.

---

# Addendum — write-path and attribute-query reconfiguration

**Date:** 2026-08-17

**Applies to:** changes made after `bd876ee`. Everything above this line remains
the verification record for `7bd338e` and is not restated or revised here; the
configuration it measured is no longer the configuration that ships.

## What changed

1. **The batcher drains its whole queue per flush.** It previously stopped at
   `BATCH_TARGET_ROWS` (2,000) even with a much deeper backlog waiting, paying
   the fixed per-transaction cost — connection checkout, `BEGIN`, `SET LOCAL`,
   rollup upsert, `COMMIT` — once per 2,000 rows. `BATCH_TARGET_ROWS`,
   `BATCH_MAX_ROWS` and `BATCH_TARGET_BYTES` were removed; `QUEUE_MAX_ROWS` and
   `QUEUE_MAX_BYTES` are now what bound a single transaction, enforced at
   admission so backpressure still surfaces as `503` + `Retry-After`.
2. **`attributes` gained a `jsonb_path_ops` GIN index** with `fastupdate = off`
   (`002_attributes_gin.sql`). `buildPredicates` narrows with a containment
   disjunction and rechecks the exact `->>` equality, which preserves the
   previous semantics exactly.
3. **The `trace_id` hot-attribute index left the shipped compose**
   (`HOT_ATTRIBUTE_KEYS=`), and **`wal_compression` was dropped**.
4. **Two defects were found and fixed while doing the above** — see below.

## Defects found

- **`ensureHotAttributeIndexes` dropped indexes it did not own.** Its sweep
  matched `indexname LIKE 'logs_attr_%'`, and `_` is a single-character
  wildcard in SQL `LIKE`, so the pattern also claimed every index merely
  *beginning* with those letters. It silently dropped `logs_attributes_gin_idx`
  on every startup, which presented as the new index never existing. The
  underscores in the prefix are now escaped.
- **An out-of-range numeric attribute filter returned 500.** The containment
  term is only emitted for a value that could have been stored, guarded on
  `Number.isFinite`. That guard is insufficient: `1e-999999` parses to a finite
  `0` in JavaScript while PostgreSQL rejects the jsonb literal with "value
  overflows numeric format", turning a well-formed query into a 500. The guard
  now also rejects a literal that underflowed to zero. Regression tests cover
  both directions.

## Verification performed

| Area | Result | Evidence |
| --- | --- | --- |
| Typecheck and tests | Pass | Typecheck exited 0; 26/26 passed with PostgreSQL, integration tests included |
| Contract and reliability scripts | Pass | Smoke passed; reliability passed 73/73 |
| Failure drill | Pass | `db +243000 = accepted 243000`; graceful `SIGTERM` drain; no container restart; final health 200 |
| Attribute semantics, live HTTP | Pass | `attr.retry=1` matches a stored number `1`; `attr.retry=1.0`, `attr.ratio=1.50` and `attr.cached=false` correctly return nothing; `attr.k=1e±999999` returns 200 |
| Hot-key sweep after the escape fix | Pass | Configuring `trace_id` creates its index and leaves the GIN index; clearing it drops only its own |
| Migration on a clean volume | Pass | `logs_attributes_gin_idx` present with `{fastupdate=off}`; a partition created later inherits the option |
| Benchmark provenance | **Fail** | Ad-hoc harnesses, no raw capture retained under `bench/raw/`, load generator co-resident with the containers |

## Evidence limits

- The throughput figures in the README's *Reconfiguration results* were taken
  with ad-hoc scripts, not the committed `bench/` protocol, and nothing was
  retained under `bench/raw/`. The load generator competed with the containers
  for host CPU. **The deltas are the result; the absolute figures are soft.**
- The read-after-write result is a success *rate* (100% of probes found their
  row), not the delay distribution the freshness gate asks for. That gate stays
  open.
- Page latency, drain rate, and the storage snapshot were **not** re-measured.
  The added GIN index changes the index footprint and nothing here re-captured
  it.

## Required follow-up

1. Re-run the committed protocol in `plan/05-BENCHMARK-PROTOCOL.md` against
   this configuration, with unique run names and retained raw output, so the
   reconfiguration figures reach the same standard as the Phase 5 ones.
2. Re-capture the storage snapshot; `logs_attributes_gin_idx` adds a fifth
   index per partition whose size has never been measured.
3. Re-run the 3 M-row drain. Items 1, 2 and 4–6 of the original follow-up list
   above are unaffected by this work and still stand.
4. Profile the application container. It is now the binding constraint at ~46%
   of its 0.5-CPU cap while PostgreSQL sits at ~33%, which inverts the
   assumption the earlier tuning was written against.

---

# Addendum 2 — Linux verification

**Date:** 2026-08-17

**Full record:** `docs/linux-verification-results.md`. This section carries only
the disposition; that file holds the measurements, provenance and evidence
limits.

The branch was re-measured on native Linux (Ubuntu 24.04, 16 CPU, Docker 29.7.2)
under the shipped container caps, because every figure in Addendum 1 came from
Docker Desktop on the WSL2 backend with a co-resident load generator.

## What the run settled

- **Both hypotheses put to it were refuted.** The application-CPU bottleneck is
  *not* a WSL2 artifact — the `/metrics` ceiling reproduces at 934 req/s on
  native Linux and scales 3.6× when only the CPU cap is raised. The batch-size
  curve does *not* flatten; per-request cost belongs to the service.
  Addendum 1's follow-up 4 therefore stands rather than being withdrawn.
- **Freshness (original follow-up 4) can be closed.** 3,821 of 3,821 probes
  found their row on the first attempt; delay p50 95 ms, p95 214 ms, p99 303 ms.
  The delay distribution matches the probe's own latency, so there is no
  visibility lag to measure.
- **Storage (Addendum 1 follow-up 2) is captured.** The GIN index is 131 MB of
  477 MB of index at 3.17 M rows. Addendum 1 said it "adds a fifth index per
  partition"; that was wrong — the shipped configuration carries **three**.
- **Correctness held throughout**, on both platforms: 26/26 tests with the
  integration tests actually running, smoke, 73/73 reliability, graceful
  `SIGTERM` drain with every acknowledged row persisted, and a full 3,165,800-row
  walk returning exactly the trusted count with 0 duplicates and 0 ordering
  violations.

## Defect found, and fixed since

A database outage returned **`500` instead of `503`** on `GET /logs`,
`GET /logs/aggregate` and `POST /logs`, failing four failure-drill checks. The
classifier in `src/db/pools.ts` listed `ENOTFOUND` but not `EAI_AGAIN`, and
which of those arrives depends on the resolver rather than the fault. It also
prevented `withDatabaseRetry` from retrying a resolver failure at startup.

The whole `getaddrinfo` family is now classified as unavailable. The defect
survived this long because the classifier — the single decision point behind
every `503` — had **no unit test at all**; it now has one, covering both
directions, including that a client's own error must never read as the database
being down.

## Still open

1. **No client-side query deadline.** With PostgreSQL frozen rather than
   stopped, a read hung past 20 s. `statement_timeout` is enforced by the
   server, so a query already checked out on a frozen connection has no
   client-side deadline to fall back on. Not covered by any test. Needs a
   decision on `query_timeout` before it is worth implementing.
2. **15,000 logs/s is not met under the shipped 0.5-CPU application cap**
   (14,320 logs/s sustained on that host; 25,574 with the cap at 2.0 CPU).
   A cap choice, not a defect — but a decision.
3. **Query-performance targets are missed by a wider margin than recorded**:
   drain 98.4 s at 32.2 pages/s against ≤30 s and ≥100 pages/s, page p95
   87.3 ms against ≤8 ms. Slower hardware, and the drain is application-CPU-bound.
4. **`scripts/failure-drill.sh` and `scripts/capture-resources.mjs` hardcode
   `server_loger-*` container names** while the compose project name derives
   from the directory. The run set `COMPOSE_PROJECT_NAME` explicitly; without
   it the drill would have produced a confident, meaningless pass. Worth a
   top-level `name:` in `docker-compose.yml`.
5. **No committed harness probes at ingestion rate**, so the mixed-workload and
   freshness figures cannot be reproduced from the repository as it stands.
6. Public history rewrite — unchanged, still the repository owner's decision.
