# Phase 4 experiment log

One variable per experiment. Every run records its full result row —
including the ones that lose — and a verdict of `keep`, `revert`, or
`inconclusive`. The measurement for every read-path experiment is the drain
harness (`scripts/drain.mjs` with `EXPECT_TOTAL` set), because the drain walk
is what a freshness walk verifies and what the plan optimises.

**Evidence note:** the exact E0 and E1+E2 console outputs were not retained in
`bench/raw/`. This file is the experiment record; its figures cannot be
independently reconstructed from the retained raw directory.

Format:

| # | change | page p50/p95/p99 (ms) | drain pages/s | rows/s | verdict |

## E0 — baseline

| # | change | page p50/p95/p99 (ms) | drain pages/s | rows/s | verdict |
| --- | --- | --- | --- | --- | --- |
| E0 | baseline (driver objects + framework JSON + 0.5 CPU) | 9.5 / 20.3 / 73.8 | 85.0 | 84,974 | reference |
| E1+E2 | PostgreSQL jsonb_build_object per row + direct response write | 15.7 / 20.7 / 76.2 | 57.5 | 57,474 | **revert** |

E1+E2 lost: pages/s fell from 85.0 to 57.5 and p50 from 9.5 ms to
15.7 ms. Building one jsonb per row is more expensive on the single
PostgreSQL CPU than the application's JSON.stringify under the same 0.5 CPU
cap — the plan's hypothesis (PostgreSQL idles during a drain) underestimated
the cost of 1,000 jsonb_build_object calls on 1 CPU. Reverted to the E0
serialisation path; the correctness gates were re-run after the revert.

## E3–E7 — not evaluated

The fallback ladder (`00-MASTER-PLAN.md` §7) cuts the remaining experiments
when the clock demands; E1+E2 consumed the read-path budget and lost. The
following were cut, in ladder order, and are reported as not evaluated rather
than implied:

| # | Experiment | Cut reason |
| --- | --- | --- |
| E3 | Bounded read-ahead prefetch | first item on the fallback ladder |
| E6 | COPY vs UNNEST bulk mechanism | ladder item 2 |
| E5 | Pool layout comparison | ladder item 3 — shipped the reserved split-pool default |
| E4 | Batch shape sweep | not run — ingestion already clears the threshold with ~30% margin |
| E7 | Durability profile A/B | not run — default profile shipped, documented as the untested profile in the README |

The final run (Phase 5) therefore measures the E0 configuration — the best
measured configuration of this campaign.
