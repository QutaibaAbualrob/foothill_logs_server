# Express on Node vs Express on Bun — measured runs, 2026-08-17

The runtime swap measured alone. `runs.csv` indexes every run: 4 rows, two
interleaved pairs, on native Linux under the shipped caps (api 0.5 CPU / 256 MB,
postgres 1.0 CPU / 1 GB). Branch: `perf/bun-runtime`, whose `src/` is byte
identical to `main` — the only variable is the runtime.

This is **not** the framework comparison. Express is on both sides of every pair
here; for Express vs Fastify see `bench/results/2026-08-17-fastify-vs-express/`.

## Headline

| | Express + Node 22.18 | Express + Bun 1.3.14 |
| --- | ---: | ---: |
| Ingest, batch 33 | 8,638.9 / 9,075.9 logs/s | **20,215.9 / 20,875.0 logs/s** |
| Ratio, per pair | — | **2.34× / 2.30×** |
| Ingest p50 / p95 | 345/597, 325/531 ms | **147/257, 140/239 ms** |
| Aggregate p95 during ingestion | 173 / 236 ms | **112 / 74 ms** |
| Errors | 0 | 0 |
| api CPU, avg of 33 samples | 45.8% / 45.7% of a 50% cap | 45.4% / 45.2% |
| postgres CPU, avg | 35.0% / 36.5% of a 100% cap | **61.2% / 60.7%** |

Both sides sat at the same 0.5-CPU ceiling. Bun did roughly 2.3× the work inside
the identical CPU budget, which is what moves the constraint: on Node,
PostgreSQL kept ~65% of its CPU in reserve while the application saturated its
cap; on Bun, PostgreSQL climbs to ~61% average and touches its own ceiling
(103.9% max of a 100% cap). **The Bun figure is therefore already partly
database-limited — it is a floor on the runtime's headroom, not a ceiling.**

Batch 33 is the point where `docs/test_results/batch33-and-cpu-profile.md` §1
showed the application container to be the constraint, which is why the swap
pays here. It does not follow that it pays as much at batch 200, where the
framework and runtime share of on-CPU time is far smaller.

## Protocol

Per run, exactly as the recorded batch-33 point was taken: `docker compose
down -v` (clean volume), `up -d --build --wait`, then 60 s at concurrency 96,
batch 33, with `scripts/capture-resources.mjs` sampling both containers, then
the full drain walk. One run at a time; the two stacks were never up together.

Both traps recorded in `2026-08-17-fastify-vs-express/README.md` are respected:

1. **Interleave and repeat.** These four runs are one session, interleaved
   node → bun → node → bun, clean volume each. The two Node runs landed 5% apart
   (8,639 / 9,076) and the two Bun runs 3% apart (20,216 / 20,875) — the gap
   between runtimes is an order of magnitude larger than the spread within
   either.

   *Amended 2026-08-17:* this section originally cited that file's "host drifts
   ~29% between sessions" claim, which has since been **withdrawn**. That claim
   came from comparing an Express run against a Fastify run under the same
   label — trap 2, in other words. Measured noise is ~6% within a session and
   ~11% across. The two Node + Express runs recorded here (8,639 / 9,076) are
   part of what corroborated the 8,170 baseline and exposed the error.

   The requirement to interleave and repeat is unchanged; the reason is ordering
   effects, growing table size and mislabelled builds rather than an unstable
   machine.
2. **A label is not proof of what is running.** Each run asked the container
   what it was before measuring, recorded in the run log as `PROOF pid1`:
   `node dist/src/index.js` versus `bun run src/index.ts`, with
   `ls node_modules | grep -xE "fastify|express"` returning `express` on all
   four. All rows are `validity: verified`.

Two runs per side is below the three the protocol asks for. The direction is not
in doubt at this margin — a 130% gap against 3–5% within-runtime spread survives
the ~6% session noise comfortably — but treat **2.3×** as the measured range's
midpoint rather than a settled constant.

## The drain numbers are not a like-for-like comparison

| | Node | Bun |
| --- | ---: | ---: |
| Rows walked | 526,185 / 553,476 | 1,214,301 / 1,260,501 |
| pages/s | 43.4 / 43.2 | 47.6 / 47.6 |
| page p50 / p95 | 16.8/59.4, 17.4/57.6 ms | 15.8/47.3, 15.8/48.5 ms |

Each drain walks whatever that run ingested, so Bun's walk covered ~2.3× the
rows — a bigger table and a bigger index (192–199 MB vs 83–87 MB). Bun being
faster per page *on more data* is a real signal, but a clean read-path
comparison needs both sides walking an identically sized dataset, and that run
has not been done. Correctness held everywhere: 0 duplicates, 0 ordering
violations, true end reached, unique ids matching `count(*)` in all four runs.

The ≤8 ms p95 page target is missed by both runtimes, as it is on `main`.

## What is not here

The raw harness output (16 files: result JSONs, resource CSVs, capture
summaries) is written to `bench/raw/`, which is gitignored. Per the rule in
`2026-08-17-fastify-vs-express/README.md`, it is copied to the private analysis
repository — location and rules in `plan/internal/SANITIZATION.md` §7 — in the
same session it was measured, because it is not reproducible from this
repository afterwards.

## Not measured

- Batch 200 and the rest of the batch curve on Bun. Only batch 33 was run, and
  it is the point most favourable to a runtime swap.
- Read-path profile on either runtime — still the open item in `agents.md`.
- Fastify + Bun, the combination this branch exists to enable.
- Sustained runs longer than 60 s, and memory behaviour under them. Peak RSS was
  not captured; the sampled values stayed well inside the 256 MB cap.
