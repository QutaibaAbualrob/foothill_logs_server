# The partial edge second — what was built and what was measured

Date: 2026-08-20. Follows [`aggregate-cache.md`](aggregate-cache.md), which made
the aggregate's *interior* free and left its *edge* on SQL.

Local measurements only. Nothing here predicts an end-to-end result, and this
change in particular is one the local benchmark CLI is structurally unable to
see — see "Why the local gate is blind" below.

## The problem, demonstrated

The per-second counters cannot answer an edge, because an edge is a prefix or
suffix of one second. Whether that costs anything depends entirely on where the
window's upper bound comes from:

| upper bound | edge second | statements per aggregate |
| --- | --- | ---: |
| a fixed instant in the future | in dead time, empty | **0** |
| read from the clock | the **current** second | **1, on 10 of 10** |

Measured by running both window shapes through the real `computeEdgeSlices` and
`secondHasRows`, not by inference. Under a clock-derived bound the edge lands in
the current second, which at any real ingest rate is never empty, so the
"boundary second is empty" shortcut never fires and every request issues a
fragment.

That fragment reads at most one second of rows. Its cost is not the read — it is
the wait for one of two pool connections that every other reader is also queued
on.

## What shipped

- A **total-only** per-millisecond layer covering the last 10 seconds, written
  alongside the per-second counters on every committed row.
- An unfiltered query whose edge falls inside that window has its partial second
  summed exactly from memory.
- A **filtered** query with a live edge **declines** to the existing SQL
  fragment. The layer is total-only, and summing a total under a service or
  level filter would be a confidently wrong number.
- An edge older than 10 seconds also declines: hydration groups by second and
  cannot reconstruct sub-second detail, so answering would mean returning a
  partial sum.

**Total-only is the load-bearing choice.** One number per millisecond is
~15,000 entries regardless of service cardinality. A per-key map would scale
with cardinality and could trip the cell valve, which disables the whole cache
rather than degrading it.

**There is no rollup, so there is no rollup bug.** The millisecond layer is not
a summary of the per-second one and never folds into it — both are written on
ingest. The interior scan reads only whole seconds; the edge reads only the
partial seconds the interior excludes. No row can be counted by both. The
obvious place for an off-by-one was designed out rather than tested.

## A guard that was too strict

The check rejecting a window with no whole-second interior used `<=`. Only a
*strictly* inverted interior is unsafe: when `alignedSince` and `alignedUntil`
are equal the two edges abut exactly and tile the window with no gap and no
overlap. That is not a rare shape — any window crossing a single second boundary
produces it, including windows wider than a second (`since` at `.200`, `until`
at `.635` of the next second). The old comment claimed it only happened for
windows "narrower than the second containing it", which was wrong.

This surfaced as a **flaky test**: the assertion passed or failed depending on
`Date.now() % 1000`. The fixture is now anchored to a real second boundary so
the window's geometry is fixed rather than a function of when the test runs.

## The gate

Five integration tests, all against a live database, all asserting exact
equality with SQL. New cases in this change:

- a clock-derived window issues **zero** statements;
- a filtered clock-derived window declines to **exactly one**;
- rows sit **exactly on both bounds**, so a half-open range cannot be confused
  with a closed one;
- a window entirely inside one populated second does not double-count;
- an edge predating the millisecond window declines rather than returning a
  partial sum.

**Ten mutations were injected, and all ten failed the suite.**

| mutation | caught by |
| --- | --- |
| interior scan includes one extra second | randomised sweep |
| coverage floor ignored | mechanism test |
| service-only filter ignored | randomised sweep |
| millisecond floor ignored | boundary test |
| total used under a service filter | filtered-decline test |
| edge upper bound inclusive | rows-on-bounds test |
| edge lower bound exclusive | rows-on-bounds test |
| millisecond layer never written | zero-statement test |
| inverted-interior guard removed | sub-second window test |
| left-edge fragment never issued | randomised sweep |

**Two of those survived the first version of the gate**, and both drove a new
test rather than a shrug: the fixture originally stepped 7 ms at a time so no
row ever sat on a bound, and the randomised sweep produces a sub-second window
only about 0.6% of the time. A gate that cannot fail is worse than no gate, and
this one could not fail in exactly the two places the new code was most likely
to be wrong.

## Why the local gate is blind

The tester the local CLI ships builds its aggregate window from fixed constants,
so its upper bound is always in the future and the edge is always empty. Under
that shape this change does **nothing at all** — the statement count was already
zero. A local A/B on it is guaranteed to measure noise.

That is measurement standard rule 10, and it is why the local CLI run below is
reported as a **regression gate only**: it can show that nothing broke, and it
cannot show whether anything improved.

## Gates

| gate | result |
| --- | --- |
| `tsc --noEmit` | clean |
| full test suite | **41 / 41** |
| contract smoke | ok |
| reliability checks | **73 / 73**, 0 failures |
| failure drill | **PASS** — 398,600 acknowledged rows persisted across a PostgreSQL restart and SIGTERM |
| local CLI regression | **95.276**, correctness **15/15** — see below |

## Local CLI regression

| report | total | load agg p95 | queries | correctness | machine speed |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline 1 | 95.088 | 51 ms | 14.081 | 15/15 | 0.1192 |
| baseline 2 | 95.787 | 41 ms | 14.261 | 15/15 | 0.1209 |
| baseline 3 | 94.933 | 58 ms | 13.956 | 15/15 | 0.1190 |
| stage 1 (one round trip) | 95.598 | 45 ms | 14.190 | 15/15 | 0.1197 |
| counters (run 6) | 95.480 | 34 ms | 14.388 | 15/15 | 0.1201 |
| **millisecond edge** | **95.276** | 52 ms | 14.064 | **15/15** | **0.1246** |

Total sits inside the 94.933-95.787 band and correctness is 15/15, which is what
this gate exists to confirm. Error rate 0.00% on load, all four scenarios
`consistencyPassed`.

**Machine speed 0.1246 is outside the 0.1190-0.1209 band every earlier run
held.** The host was faster this time, so this run is **not strictly comparable**
to the rows above it and the latency columns should not be read against them.
Correctness is unaffected — the CLI states that its catalog and k6 script match
the platform exactly — and correctness is the only column this gate is really
being asked about.

The aggregate p95 of 52 ms against the counters run's 34 ms is **not evidence of
a regression, and not evidence of anything else**. Under the local tester's
fixed-future window this change alters nothing: the edge was already empty and
the statement count was already zero. 52 ms sits inside the 41-58 ms baseline
band, on a differently-paced host, measuring a code path this change does not
touch. Reading it either way would be reading noise.

## What is deliberately not claimed

- **No end-to-end result**, and no local evidence of improvement is even
  possible for this change.
- **The write path is still untouched.** The rollup upsert continues to run
  inside every flush transaction.
- **Filtered aggregates with a live edge are unchanged**, by design.
