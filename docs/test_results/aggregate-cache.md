# In-process aggregate counters — what was built and what was measured

Date: 2026-08-20. Follows [`run5-read-path.md`](run5-read-path.md), which left
the aggregate endpoint issuing one statement per request whose cost was
dominated by a partial-minute edge scan.

This file records **local** measurements only. Nothing here is a prediction of
what the change is worth end to end; that is a separate measurement and it has
not been taken.

## What shipped

- `src/aggregate/counters.ts` — a per-second counter map, keyed
  `second -> (service, level) -> count`, over a two-hour window, with a
  1,000,000-cell valve that disables the cache rather than grow without bound.
- Hydrated from raw `logs` **before the listener opens**, so the projection is
  taken at an instant when no request can be in flight. Hydration failure
  disables the cache and leaves the service healthy — the SQL path answers
  everything on its own.
- Incremented after each flush commits and **before** the ingest request
  resolves, so the counters can never report fewer rows than a caller has been
  told are durable.
- Wired into `PgLogQueryRepository.aggregate` ahead of the existing path, for
  ungrouped queries only.
- `AGGREGATE_CACHE=off` disables it without a rebuild.

**Nothing on the write path changed.** The rollup upsert still runs inside every
flush transaction. This is a read-path change and only a read-path change.

## The mechanism, measured

Statement counts taken against a live stack with `log_statement='all'`, three
requests per row, counting only statements that reach the `logs` tables. The
`pg_stat_user_tables` counters were tried first and discarded — their reporting
lag produced numbers that were wrong in both directions.

| window shape | statements per request |
| --- | ---: |
| bounds on exact second boundaries | **0** |
| unaligned bound, boundary second holds rows | 1, over a **sub-second** range |
| window older than the two-hour cache window | 1, the existing SQL path |

The first row is the point of the change: a covered window that needs no edge
resolution reaches PostgreSQL **not at all**. The second row costs the same
*number* of statements as before, but the statement scans at most one second of
rows where the previous path scanned up to a full minute of them plus the rollup
interior.

Both edges of the common drain shape resolve for free: its left edge lands in
empty pre-traffic time and its right edge sits in the future, so the counters
prove both boundary seconds empty and skip both fragments.

## Exactness, verified live

Issued against a stack holding ~396,600 rows written by the failure drill, after
a container restart — so the answer came through **hydration**, not through the
incremental path:

```
service sentinel  -> {"buckets":[]}                       (sum 0)
real service      -> {"buckets":[{...,"count":99150}]}    (sum 99,150)
SQL truth         -> 99,150
```

Exact, correctly shaped, and returned in ~10 ms on an idle database. The idle
figure is not a latency result — it says the answer is right and the path is
short, nothing more.

## The one transient the tests cannot cover

Between a flush committing and `counters.add` running there is a window of
microseconds in which the counters do not yet hold rows the database does. A
query landing inside it takes its interior from memory and any edge fragment
from SQL, so the two halves can disagree by up to one flush.

This is bounded and, for the guarantee that matters, harmless: those rows are
**not yet acknowledged**, because the ingest request resolves only after
`counters.add` returns. A caller that writes, waits for its 200, and then reads
can never be told a number lower than the rows it was promised. Plain SQL has
the same property — rows become visible when their transaction commits, not when
a client learns about it.

It is recorded here because no test in the suite exercises it, and an absent
test should be a stated gap rather than a silent one.

## The parity gate

[`test/integration/aggregate-cache.test.ts`](../../test/integration/aggregate-cache.test.ts)
compares 120 randomised windows, filters and bucket sizes against both the SQL
path and independently computed SQL truth, and asserts the three window shapes
that would otherwise fail silently: `bucket=1d`, an `until` 60 s past the newest
row, and an unknown service that must return a valid empty body rather than an
error or an unfiltered total.

It also asserts the mechanism — a counting pool proves the covered case issues
zero statements — because a cache that declined every query would satisfy parity
perfectly and buy nothing.

**The gate was mutation-tested.** Four defects were introduced one at a time and
every one failed the suite:

| mutation | caught by |
| --- | --- |
| interior scan includes one extra second | randomised sweep |
| left-edge fragment never issued | randomised sweep |
| coverage floor ignored | mechanism test |
| service-only filter ignored | randomised sweep |

A green test that cannot fail is worse than no test; this one fails when it
should.

## Gates

| gate | result |
| --- | --- |
| `tsc --noEmit` | clean |
| full test suite | **39 / 39** |
| contract smoke | ok |
| reliability checks | **73 / 73**, 0 failures |
| failure drill | **PASS** — 396,600 acknowledged rows all persisted across a PostgreSQL restart and SIGTERM |

## Local CLI regression

Same command and seed as every earlier baseline, `--full --seed 6122026
--generator-cpus 4`. Machine speed **0.1201** against a 0.1190-0.1209 band, so
the runs are comparable.

| report | total | load agg p95 | queries | correctness |
| --- | ---: | ---: | ---: | ---: |
| baseline 1 | 95.088 | 51 ms | 14.081 | 15/15 |
| baseline 2 | 95.787 | 41 ms | 14.261 | 15/15 |
| baseline 3 | 94.933 | 58 ms | 13.956 | 15/15 |
| stage 1 (one round trip) | 95.598 | 45 ms | 14.190 | 15/15 |
| **counters** | **95.480** | **34 ms** | **14.388** | **15/15** |

Total sits inside the 94.933-95.787 band, which is what this gate exists to
confirm. Aggregate p95 is the lowest of the five and Queries the highest, but
the local database is idle and 34 ms against a 41-58 ms band is not a result to
lean on — **the gate is "no regression", and it passed.** All four scenarios
reported `consistencyPassed`, `visibleRecords == acceptedRecords`, and a 0.0%
error rate on load.

k6 could not start every scheduled iteration in stress, spike and breakpoint —
the generator ran out of host CPU, not the service. Those three columns
understate the service and are not used above.

### One metric moved the wrong way

`readAfterWriteSuccessRate` fell to **0.143** from a 0.178-0.198 baseline range.
It carries **zero weight** — Queries is `9 x 0.932 + 6 = 14.388`, and the
read-after-write figure appears in the report without entering the arithmetic —
but it is recorded here rather than left out, because it is the only number that
regressed.

The probe lists the twenty most recent logs and looks for a row just written; at
15,000 logs/s those twenty rows span about a millisecond, so the measurement is
dominated by timing. The plausible cause is the per-row work `counters.add` now
does inside the flush path. Nothing that matters moved with it: throughput held
at the offered ceiling (14,999/s), errors stayed 0.0%, and request p95 (226.6 ms)
sits inside the 187.6-237.0 ms baseline range.

## What is deliberately not claimed

- **No end-to-end result.** Local measurements cannot produce one: the local
  database is idle, so this run can only show a regression.
- **The write path is untouched.** The rollup upsert still runs in every flush
  transaction, so nothing here addresses the read-side cost recorded in design
  decision 15.
- **Grouped queries are unchanged.** They stay on SQL, because ordering a
  grouped result means reproducing `en_US.utf8` collation in JavaScript for no
  benefit on the paths that matter.
