# Mixed workload — reads during ingestion: Express + Node vs Fastify + Bun

**Date:** 2026-08-18
**Harness:** `scripts/mixed-workload.mjs` (`npm run bench:mixed`), new in this session
**Builds:** `main` at `ec09f9c` (Express + Node 22.18) vs `perf/fastify-bun` at `592e17a`
(Fastify + Bun 1.3.14), each verified in-container on every run
**Caps:** unchanged — api 0.5 CPU / 256 MB, postgres 1.0 CPU / 1 GB
**Protocol:** 3 interleaved pairs, clean volume per run (`rows_before: 0`), one stack up at
a time, no other containers, 60 s load + 30 s visibility window, 15,000 logs/s target at
batch 33, 1,000-row pages

## Why this harness exists

Every previous read-path number in this repository was measured against a
**static table with no concurrent writers**: `drain.mjs` walks pages on a quiet
system, `benchmark.mjs` ingests with nobody reading. The service exists to serve
queries *while* it ingests, and that combination had never been measured.

Two design choices are load-bearing:

1. **The load is open-loop.** `benchmark.mjs` uses a fixed worker pool that
   sends, awaits, then sends again — so when the server slows the client sends
   less, offered load collapses to whatever the server can absorb, and a backlog
   can never form. This harness dispatches against a wall clock regardless of
   completions, and records what its in-flight ceiling prevented as `shed`.
2. **Visibility is measured while writes continue.** A reader catching up on a
   table nobody is writing to has the whole CPU to itself; measured that way the
   Express build reported 100% visible instead of ~15%.

## Result

| Metric | Express + Node | Fastify + Bun | factor |
| --- | ---: | ---: | ---: |
| **Drain under load** | 0.96 / 1.01 / 1.09 pages/s | **19.64 / 19.88 / 21.68** | **~19×** |
| Page p95 | 802 / 892 / 897 ms | 85.8 / 88.7 / 89.8 ms | ~10× |
| Aggregate p95 | 617 / 879 / 2,318 ms | 86.1 / 94.8 / 216.6 ms | ~7× |
| **Visible in 30 s** | 14.5 / 14.7 / 15.3% | **99.6 / 99.7 / 99.8%** | — |
| Limited by | window (ran out of clock) | **data (walked everything)** | — |
| Ingest | 8,030 / 8,590 / 8,896 logs/s | 14,919 / 14,939 / 14,989 | ~1.75× |
| api CPU avg | 46% of a 50% cap | 45% of a 50% cap | — |
| postgres CPU avg | 28–33% | **72–76%, peaks 97–102%** | — |

Spread within each side is 10–13%, comparable to the ~6–11% session noise already
calibrated in `agents.md`. The effect is 19×, far outside it. Fastify + Bun wins
every one of the three pairs on every column.

### The `limitedBy` column is the finding

Express stops because the **30-second window expires** — it is still walking,
roughly 1 page per second, with most of the data unreached. Fastify + Bun stops
because it **ran out of rows**: it walked the entire cohort and reached the true
end with time to spare, having accepted nearly twice as many rows to begin with.

That is the difference between a reader that is behind and a reader that is
caught up, and no ingest-only benchmark in this repo could have shown it.

### It breaks the throughput/freshness tension

The concern going in was that faster ingest makes readable-freshness worse: more
accepted rows mean more for a reader to traverse. The measurement says the
opposite here. Fastify + Bun accepts **~1.75× more** and still makes **99.7%**
visible, against Express's 14.8%. The two were only in tension because the reader
was losing a CPU fight it now wins.

### The constraint has moved to PostgreSQL

| | api (0.5 cap) | postgres (1.0 cap) |
| --- | ---: | ---: |
| Express + Node | 46% avg — pinned | 28–33% avg |
| Fastify + Bun | 45% avg — still near cap | **72–76% avg, peaks >100%** |

Under Express the application was pinned while the database idled at a third of
its capacity. Under Fastify + Bun the application is still near its ceiling, but
PostgreSQL has become the busy component. Further application-side tuning has
much less headroom than it did; the next real gains are in the database.

## Why the gain is ~19× and not the ~2× a per-request cost model predicts

Per-request application cost roughly halves under Bun, so a constant-factor model
predicts about 2×. The measured drain gain is an order of magnitude larger,
because the Express baseline was not merely slow — it was **starved**. Its 5 s
series shows the reader completing *zero* pages for ~15 consecutive seconds while
ingest ran. Freeing application CPU did not make each page cheaper by a fixed
factor; it ended the starvation. This is a regime change, not a speed-up, and it
is why extrapolating from the idle-table numbers would have been wrong in both
directions.

## Method note — a defect found and fixed in this harness

The first version of the visibility metric divided rows walked by rows accepted
at load-end, while the walk itself ran under continuing load and filtered only on
`since`. Rows written *during* the walk therefore entered the numerator while the
denominator stayed frozen, and one run reported **100.1% visible** — impossible,
and a signal the metric was unsound at exactly the end of the range where the Bun
result sits.

It now bounds the walk with `since` **and** `until=<cutoff>` and computes the
denominator over the same half-open window, matching `builder.ts` (`timestamp >=
since`, `timestamp < until`). Batches are recorded against their own timestamps
and summed after all in-flight requests settle, so a batch dispatched just before
the cutoff is counted on both sides rather than only in the walk. The ratio is now
bounded by 1 by construction. Every number in the table above comes from the
corrected harness; the superseded runs are kept in
`bench/raw/superseded-metric-v1/` — their drain, latency and CPU columns were
never affected.

## What this means for the adoption decision

`agents.md` framed the open question as whether Fastify + Bun is worth merging for
ingest throughput. On this evidence that was the wrong question. **It is the only
measured change that addresses the read path**, and the read path was the part
that was broken.

## Next

1. **Merge `perf/fastify-bun`**, with the two outstanding adoption items: make Bun
   the shipped default (fold the overlay into `docker-compose.yml`/`Dockerfile`,
   re-verify zero-config startup) and switch CI to build and smoke the Bun image.
2. **The database is now the constraint.** Profile it under this harness before
   any further application-side work.
3. **The write-path index question** (`logs_service_level_page_idx`) should be
   re-judged here rather than in isolation — with postgres at 72–76%, write
   amplification now costs the component that is actually busy.
4. Longer runs. Nothing here exceeds 60 s of load; sustained behaviour and RSS
   under a soak are still unmeasured.

## CHANGES

- 2026-08-18: created — first measurement of the read path under concurrent
  ingest, Express + Node baseline only.
- 2026-08-18: visibility metric corrected (bounded cohort, `limitedBy`), and the
  full interleaved A/B against Fastify + Bun added.
