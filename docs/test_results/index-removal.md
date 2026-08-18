# Pricing the two zero-scan indexes

**Date:** 2026-08-18
**Build:** `perf/db-write-cost` from `main` at `881bd25` — Fastify on Bun 1.3.14
**Harness:** `scripts/mixed-workload.mjs` (`npm run bench:mixed`)
**Runs:** 30, three interleaved pairs per cell, clean volume per run, build
verified in-container every run, one stack up at a time, zero errors throughout

## Why

`docs/test_results/postgres-profile.md` found two indexes maintained on every
inserted row that took **zero scans** in the profiled run —
`logs_service_level_page_idx` (116 MB) and the attributes GIN (57 MB) — inside
the `COPY` that owns 71.3% of database time. That makes them *pure write cost
under this query mix*, which is not the same as useless: this workload's reads
are an unfiltered cursor walk plus aggregates, and never filter by `service`,
`level`, or an attribute.

So the question was never "is the write path cheaper without them" alone. It
was **what does each one cost to remove, measured against the query shape it
exists to serve.**

## Result

**Drop `logs_service_level_page_idx`. Keep the attributes GIN.** Split, not
unanimous — and the split is only visible because the read side was measured.

## 1. Screen — both indexes together (a screen, not evidence)

Batch 33, unfiltered walk, 15,000 logs/s target, 3 interleaved pairs.
Deliberately two variables at once, to decide whether the effect justified a
full matrix.

| | Baseline | Both dropped | |
| --- | ---: | ---: | --- |
| PostgreSQL CPU avg | 77.0–79.6% | 54.2–55.1% | −30.3% |
| WAL generated | 900.7–901.1 MB | 393.4–394.0 MB | −56.3% |
| Ingest p95 | 470.8–572.2 ms | 331.7–368.2 ms | −32.7% |
| api CPU avg | 46.8–47.0% | 46.7–47.4% | +0.6% |
| **Ingest throughput** | 14,948–14,992 /s | 14,962–14,997 /s | **0.0%** |

Heap size was identical on both sides (228–229 MB), confirming the same data
was written.

**The throughput column is the methodological lesson.** It did not move because
the harness offers a fixed 15,000 logs/s target and both sides met it with zero
shed. A write-cost reduction has nowhere to appear as throughput unless the
offered rate exceeds what the service can serve. Every later write cell was
therefore run **above capacity**, and the throughput gains below are the
difference that change made.

## 2. Read half — the part that decided it

One variable per cell; the index under test is the only difference.

### R1 — service-filtered walk, `DRAIN_FILTERS=service=checkout`

The shape `(service, level, timestamp DESC, id DESC)` exists for.

| | Baseline | Index dropped |
| --- | ---: | ---: |
| pages/s | 12.6–13.1 | 12.4–14.4 |
| page p50 | 26.6–34.7 ms | 21.7–30.4 ms |
| page p95 | 157.3–179.0 ms | 171.1–181.7 ms |
| read errors | 0 | 0 |

**No regression.** Every band overlaps and p50 is if anything better. Two
things explain it: `service=checkout` matches about one row in four, so a
backward primary-key scan discards three rows per row returned — cheap at a
96.2% buffer hit ratio — and the CPU freed by not maintaining the index pays
for the extra rows examined.

### R2 — selective attribute point lookup, `DRAIN_FILTERS=attr.trace_id=…`

The shape migration `002` justifies the GIN with.

| | Baseline | GIN dropped | Factor |
| --- | ---: | ---: | ---: |
| lookups/s | 80.8–99.0 | 4.0–4.5 | **0.05×** |
| p50 | 2.4–2.7 ms | 106.1–110.6 ms | **42.7×** |
| p95 | 33.4–41.7 ms | 383.5–413.7 ms | 11.1× |
| read errors | 0 | 0 | |

**The GIN earns its 57 MB.** Zero read errors on both sides, so this is genuine
slowness rather than statement timeouts being counted as failures. Migration
`002`'s original claim (~158 ms → ~0.4 ms at 671k rows) holds in shape at twice
the row count and under concurrent ingest.

## 3. Write half — service index alone, at saturation

The GIN is forced **present on both sides**; only
`logs_service_level_page_idx` varies. Targets are set above capacity on
purpose (30,000 /s at batch 33, 45,000 /s at batch 200), so heavy shedding at
batch 33 is expected and is not a fault — achieved logs/s is the measurement.

Absolute WAL and CPU are not comparable between sides here, because the sides
process different row counts. Normalized per ingested row:

| | batch 33 baseline | batch 33 dropped | Δ | batch 200 baseline | batch 200 dropped | Δ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| throughput (logs/s) | 22,747–23,073 | 24,320–26,622 | **+12.4%** | 22,222–24,724 | 28,434–30,679 | **+25.1%** |
| WAL bytes/row | 709.8–710.6 | 579.9–582.7 | **−18.2%** | 707.4–710.6 | 575.3–577.6 | **−18.7%** |
| pg CPU per krow/s | 3.17–3.53 | 2.73–2.83 | −16.4% | 2.98–3.24 | 2.40–2.48 | −22.0% |
| api CPU avg | 44.9–46.8% | 45.4–46.6% | +0.3% | 46.5–47.5% | 47.0–47.2% | +0.2% |

**Every normalized band is separated**, against ~6% within-session noise, and
the WAL figure is nearly variance-free within each side.

**The gain is larger at batch 200 than at batch 33** (+25.1% against +12.4%).
That is the expected direction: per-row HTTP and application overhead is lower
at batch 200, so the database share of the work is higher and removing database
work matters more. It also lands at the operating point that matters, since
batch 200 is where the 15,000 logs/s target lives.

## Validity and caveats

- 30 runs, all `verified` except the six-run screen in §1, which is labelled a
  screen because it moved two variables at once.
- Nothing exceeds 60 s of load; no soak, no sustained-RSS figure.
- One host, one session.
- §1's screen and §3's cells were run at different offered rates and are **not**
  comparable to each other; only within-section comparisons are valid.
- The R1 conclusion depends on the read set being RAM-resident (96.2% buffer hit
  ratio). A table much larger than memory, paged heavily by service, could
  reverse it — re-measure rather than inherit it.
- The attribute-filtered *walk* was not run: the harness generates no
  mid-selectivity attribute key (`trace_id` is unique per row, `region` is
  constant, `retry` has three values), so a filtered walk would match either
  every row or exactly one. R2 tests the point-lookup shape instead, which is
  what migration `002` justified the GIN with.
- Six runs of the read half were lost to a power cut and re-run; the replacement
  R2 pair reproduced the surviving two closely (106.1 ms p50 against 106.7 and
  110.6).

## CHANGES

- 2026-08-18: created. Item 1 of `plan/08-DATABASE-COST-REDUCTION.md`.
