# Express on Node vs Express on Bun — measured runs, 2026-08-17

The runtime swap measured alone, to the seven requirements in `agents.md`
§"The measurement standard". `runs.csv` indexes every run: 16 rows, of which
**12 are evidence** (two batch sizes × three interleaved pairs) and 4 are an
earlier **screen** kept for the record. The `standard` column says which.

Native Linux, shipped caps: api 0.5 CPU / 256 MB, postgres 1.0 CPU / 1 GB.
Branch `perf/bun-runtime`, whose `src/` is byte identical to `main` — the only
variable is the runtime. Express is on both sides of every pair here; for
Express vs Fastify see `bench/results/2026-08-17-fastify-vs-express/`.

## Headline

Median of three per cell, with the full spread. Zero errors in all 12 runs.

| | batch 200 | batch 33 |
| --- | --- | --- |
| Node 22.18 | 14,389 logs/s (13,689–14,681, 6.9%) | 8,217 logs/s (8,101–8,709, 7.4%) |
| Bun 1.3.14 | **28,345 logs/s** (28,139–31,105, 10.5%) | **18,648 logs/s** (18,327–18,697, 2.0%) |
| Multiple, medians | **1.97×** | **2.27×** |
| Multiple, per pair | 2.27 / 1.97 / 1.92 | 2.15 / 2.30 / 2.23 |

**Against the 15,000 logs/s target, with aggregate p95 under the 1 s
requirement:**

| | clears 15,000 logs/s? | aggregate p95 |
| --- | --- | --- |
| Node, batch 200 | **no** — 13,689 / 14,389 / 14,681 | 589 / 498 / 505 ms |
| Bun, batch 200 | **yes** — 31,105 / 28,345 / 28,139 | 284 / 166 / 179 ms |
| Node, batch 33 | no — 8,101–8,709 | 197 / 343 / 202 ms |
| Bun, batch 33 | **yes** — 18,327–18,697 | 77 / 84 / 83 ms |

Bun clears the target at both batch sizes with aggregate p95 an order of
magnitude inside the 1 s requirement. Node clears it at neither, missing by
2–9% at batch 200.

## The compression across the curve, and the confound in it

The standard predicts a swap flatters itself at batch 33 (HTTP layer 19.3% of
on-CPU time) and compresses at batch 200 (7.5%) — as the framework swap did,
+30.6% → +7.7%, a 4× compression. **The runtime swap compresses far less:
2.27× → 1.97×, a factor of 1.15.**

That number is a **lower bound**, because of what the CPU columns show:

| | api CPU avg (50% cap) | postgres CPU avg / max (100% cap) | limited by |
| --- | --- | --- | --- |
| Node, batch 200 | 44.8 / 45.1 / 44.4 | 38.5–42.9 / 64.6–87.5 | application |
| Bun, batch 200 | **33.1–34.6** | 61.3–67.7 / **84.3–100.0** | **database** |
| Node, batch 33 | 44.0–44.4 | 35.9–38.1 / 54.4–81.9 | application |
| Bun, batch 33 | 43.9–44.5 | 61.3–63.3 / 87.5–94.2 | application (postgres close behind) |

At batch 200 the Bun application container **does not reach its own cap** — it
idles a third of it — while PostgreSQL touches 100%. Those three cells are
database-limited and are marked so in `runs.csv`. Bun is not being measured
there; PostgreSQL is. The true runtime multiple at batch 200 is therefore ≥1.97×,
and the apparent compression from 2.27× is at least partly the database ceiling
arriving rather than the HTTP layer's share shrinking.

The batch-33 cells are the honest application-limited comparison: both runtimes
sit at ~44% of a 50% cap, and Bun does 2.27× the work inside it.

## Compliance with the seven requirements

| # | Requirement | How |
| --- | --- | --- |
| 1 | Interleaved | node → bun → node → bun → node → bun, at each batch size |
| 2 | Three repeats per side | 3 per cell, 12 runs total |
| 3 | Clean volume per run | `down -v` before each; `rows_before` is 0 in all 12 rows |
| 4 | Build verified inside the container | `proof_pid1` per row: `node dist/src/index.js` vs `bun run src/index.ts`; `node_modules` grep returned `express` on all 12 |
| 5 | One variable | runtime only; `git diff main -- src/` is empty on this branch |
| 6 | One stack up at a time | verified per run — `other_containers_up` is `none` in all 12. The orphaned `logs-fastify` postgres from a deleted directory was removed first, and the neighbouring `server_loger` stack was stopped for the campaign |
| 7 | Spread, errors, rows, both CPUs | above and in `runs.csv` |

Batch 200 was run first and completed before batch 33, as the brief required.

## The four earlier runs are a screen, not evidence

Rows with `standard: screen` are two batch-33 pairs taken earlier the same day.
They met requirements 1, 3, 4, 5 and 6 but only **two** repeats per side, so they
cannot separate the effect from noise on their own and their numbers must not
appear in a headline. They read 2.34× and 2.30× at batch 33 against this
campaign's 2.27× — consistent, which is a corroboration and not a substitute.

Their absolute values ran higher on both sides (Node 8,639/9,076 vs 8,101–8,709;
Bun 20,216/20,875 vs 18,327–18,697) — a session offset within the ~11% figure the
calibration note gives for across-session comparison, and exactly why the
standard forbids comparing a number to one from an earlier session. Everything in
the Headline above is from a single continuous session.

*Amendment carried forward:* an earlier version of this file cited a "host drifts
~29% between sessions" claim from `2026-08-17-fastify-vs-express/README.md`, which
has since been **withdrawn** — it came from comparing an Express run against a
Fastify run under the same label. Measured noise is ~6% within a session and ~11%
across. The requirement to interleave and repeat is unchanged; the reason is
ordering effects, growing table size and mislabelled builds rather than an
unstable machine.

## Not measured

- **Batch 50 and 500.** The curve has four points on `main`; two were measured
  here.
- **The drain walk was not part of this campaign.** It is not in the required
  report, and each walk covers whatever its own run ingested, so the sides are
  never comparable without an equal-sized dataset. The four screen runs include
  drains; treat them as screens too.
- **Fastify + Bun**, the combination this branch exists to enable. Both halves
  are now measured alone; the combination is not.
- **Peak RSS.** Sampled values stayed well inside the 256 MB cap on both
  runtimes; no peak was captured.
- **Anything above 60 s.** All runs are 60 s at concurrency 96.

## Raw output

The 36 raw files for these 12 runs (result JSONs, resource CSVs, capture
summaries) are written to `bench/raw/`, which is gitignored. They are committed
and pushed to the private analysis repository — location and rules in
`plan/internal/SANITIZATION.md` §7 — in the session they were measured, because
they are not reproducible from this repository afterwards.
