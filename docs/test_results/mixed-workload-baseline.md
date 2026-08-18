# Mixed workload — reads during ingestion (Express + Node, `main`)

**Date:** 2026-08-18
**Build:** `main` at `ec09f9c`, verified in-container (`node dist/src/index.js`, `express`)
**Harness:** `scripts/mixed-workload.mjs` (`npm run bench:mixed`), new in this session
**Caps:** unchanged — api 0.5 CPU / 256 MB, postgres 1.0 CPU / 1 GB
**Volume:** clean per run (`rows before: 0`)

## Why this harness exists

Every previous read-path number in this repository was measured against a
**static table with no concurrent writers**: `drain.mjs` walks pages on a quiet
system, `benchmark.mjs` ingests without anyone reading. The service exists to
serve queries *while* it ingests, and that combination had never been measured.

It turns out to be the difference between a healthy read path and an unusable
one, and it invalidates the read-side conclusions drawn from the idle numbers.

Two design choices matter for reproducing it:

1. **The load is open-loop.** `benchmark.mjs` uses a fixed worker pool that
   sends, awaits, then sends again — so when the server slows, the client sends
   less, offered load collapses to whatever the server can absorb, and a backlog
   can never form. Real producers do not behave that way. This harness
   dispatches against a wall clock to hold the target rate regardless of
   completions, and records anything its in-flight ceiling prevented as `shed`.
2. **Visibility is measured under sustained load.** A reader catching up on a
   table nobody is writing to has the whole CPU to itself. Measured that way the
   same build reported **100% visible**; with writes still flowing it reports
   **13.7%**. The quiet was doing all the work.

## Results — 60 s at a 15,000 logs/s target, batch 33, 1,000-row pages

| Metric | Under concurrent ingest | Same build, idle |
| --- | ---: | ---: |
| **Drain page rate** | **0.95–1.41 pages/s** | 37–54 pages/s |
| Drain page p95 | 889–909 ms | 40–50 ms |
| Aggregate p95 | 842–1,082 ms | 73–83 ms |
| Aggregate p99 | 8,702–13,596 ms | — |
| Ingest p50 / p95 | 1,697–1,774 / 2,409–2,421 ms | — |
| Ingest throughput | 8,097–8,129 logs/s | — |

**The read path degrades by 26–50× the moment writes are running.** That is the
headline, and no previously recorded number showed it.

### Acceptance is not visibility

| | run 1 (idle window) | run 2 (window under load) |
| --- | ---: | ---: |
| Accepted | 497,376 | 480,447 |
| Visible within 30 s | 497,376 | **66,000** |
| Visible ratio | 100% | **13.7%** |

A 200 from `POST /logs` means the batch was durably queued, not that a reader
can find it. Under sustained load a client sees **86% of acknowledged data as
missing** inside a 30-second catch-up window — and the visible figure is roughly
constant in the tens of thousands regardless of how much was accepted, because
it is set by the page rate, not by the write rate.

### The constraint is application CPU, not PostgreSQL

From `bench/raw/mixed-node-express-1-resources.csv`:

| Container | CPU avg | CPU max |
| --- | ---: | ---: |
| api | **50.7% of a 50% cap** | 54.4% |
| postgres | 31.2% of a 100% cap | 48.5% |

The application is pinned at its ceiling while the database holds two thirds of
its own in reserve. Reads and writes are competing for the same 0.5 CPU, and the
reader loses.

The 5-second series shows it directly — drain pages completed per bucket:

```
6, 0, 0, 0, 0, 10, 12, 11, 12, 11, 11, 12
```

**The reader was fully starved for ~15 seconds**, completing no pages at all
while ingest ran, then recovered partially. A mean page rate hides this; the
series does not.

## What this means for work already done

- **The 2×2 (Express/Fastify × Node/Bun) measured ingest only.** Its conclusions
  about throughput stand. Its implied conclusions about the read path do not —
  every drain figure in it was taken idle.
- **The drain correctness gate remains valid** (ordering, duplicates, true end
  are correctness properties, not throughput ones), but the page *rate* recorded
  beside it describes a condition the service never actually operates in.
- **Ingest optimisation alone can make the product worse.** Accepting more rows
  per second while the page rate stays near 1 pages/s increases the backlog a
  reader must traverse. Throughput and readable-freshness trade against each
  other at the current page rate.

## Next

1. Run this harness against **Fastify + Bun**. The constraint is application CPU
   and Bun roughly halves per-request cost, so this is the one change already
   measured that targets the actual bottleneck. It is the deciding measurement
   for whether that stack should be adopted.
2. Profile the **read** path. Only ingest has ever been profiled, so which
   frames own the pinned 50% is unknown.
3. Re-check the write-path index question (`logs_service_level_page_idx`) under
   this harness rather than in isolation — its read benefit and write cost must
   be judged in the condition that matters.

## CHANGES

- 2026-08-18: created. First measurement of the read path under concurrent
  ingest; first local reproduction of the read-starvation shape.
