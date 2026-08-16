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
