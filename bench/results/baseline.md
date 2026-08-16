# Baseline — Phase 3 reference run

**Date:** 2026-08-16 · **Status:** baseline, pre-optimisation (gate G5-base)

## Environment

- Capped compose stack from `docker-compose.yml`: application 0.5 CPU / 256 MB,
  PostgreSQL 1 CPU / 1 GB, Docker on a Windows 11 host.
- Load generator on the host; service reached at `http://127.0.0.1:8081`
  (port 8080 was occupied on this machine; the shipped default is 8080).
- Database state at walk time: **1,433,144 rows** (warm — the dataset was
  accumulated across drill runs and earlier measurements; a clean final run
  happens in Phase 5).
- Build: `60b045c..d282b21` (aggregate edge slices, retention test, SIGTERM
  drill, bench rig landed).

## Ingestion (carried forward from the pre-baseline measurement in HANDOFF §6)

`scripts/benchmark.mjs`, 30 s, 64 workers, batch 200:

The exact console output was not retained under `bench/raw/`; these are
historical figures carried from `plan/HANDOFF.md`, not independently
reconstructible raw evidence.

| Metric | Value |
| --- | --- |
| Accepted | 599,600 logs |
| Throughput | 19,504 logs/s sustained |
| Errors | 0 |
| Ingest p50 / p95 / p99 | 610 / 901 / 1150 ms (whole batch of 200) |
| Aggregate p95, concurrent | 112 ms (requirement < 1 s met; internal double-digit-ms target missed) |

A fresh ingestion run with resource capture is part of Phase 5.

## Drain walk — `scripts/drain.mjs`, 1,000-row pages

| Metric | Value |
| --- | --- |
| Rows walked | 1,433,144 — **> 1 M (gate G3 satisfied)** |
| Reached true end | yes, inside the 90 s deadline (16.9 s) |
| Unique rows vs `COUNT(*)` | exact match (1,433,144) |
| Duplicates / ordering violations | 0 / 0 |
| Pages | 1,434 |
| Rate | 85.0 pages/s, 84,974 rows/s; ≥60 floor met, ≥100 target missed |
| Page p50 / p95 / p99 | 9.5 / **20.3** / 73.8 ms |

The walk crossed the million-row boundary with zero ordering violations —
the exact scale at which the historical text-vs-bigint cursor defect
manifested. G3's tied-timestamp and digit-boundary trap did not recur.

Before the cursor-ordering fix, the preliminary drain recorded 18 ordering
violations; after it, 0. That before/after number is preserved in
`plan/HANDOFF.md` and has no retained raw capture.

## Page target

**Plan target: ≤ 8 ms p95 for a 1,000-row page. Measured: 20.3 ms p95 —
missed.** PostgreSQL executes the same page in **1.7 ms** (see below), so the
gap is application-side materialisation, JSON serialisation, the HTTP write,
and host→container overhead. This is the Phase 4 hypothesis space (E1/E2).

## EXPLAIN (ANALYZE, BUFFERS) captures — `docs/explain/`

| File | Plan shape | Notes |
| --- | --- | --- |
| `page-unfiltered.txt` | `Limit` over `Merge Append` of backward `pkey` scans, 34 shared-buffer hits, no sort | execution 1.7 ms; the primary key IS the page index |
| `page-cursor.txt` | same shape with a keyset predicate | index condition on `(timestamp, id)` |
| `page-service.txt` | backward scan on `logs_service_level_page_idx` | service+level page, no sort |
| `page-hot-attr.txt` | `Index Cond: (attributes ->> 'trace_id') = …` on the partial expression index, per partition | the configured hot-key index is used; 0 rows for the probe value |
| `page-attr-generic.txt` | scan + filter on an unindexed attribute | documents the deliberate no-GIN trade-off |
| `aggregate-rollup.txt` | seq scan over `logs_agg_1m` (119 rows) + hash aggregate | rollup interior is tiny by construction |
| `aggregate-raw.txt` | raw path with `q` — full-table filter | the documented raw fallback cost |

## Storage (carried forward from HANDOFF §6, same dataset family)

203 MB total at 599,704 rows, of which **110 MB is indexes** — index overhead
over half the table size. Re-measured in Phase 5 with the final dataset.

## Correctness gates green at this commit

- `npm run typecheck`, `npm test` (22, including both DB integration tests)
- `npm run smoke` — G1, now including the unaligned-edge-minute aggregate case
- `npm run reliability` — 72/72 checks
- `npm run drill` — database outage AND SIGTERM-under-load rows, PASS

## Conclusion

Correctness and reliability are in place at full scale. The 1.433 M-row walk
completed inside 30 seconds, but the internal query targets were not all met:
85.0 pages/s missed the ≥100 target, page p95 was 20.3 ms against ≤8 ms, and
aggregate p95 was 112 ms rather than double-digit milliseconds. PostgreSQL
already answered the page in 1.7 ms, so Phase 4 experiments E1 (row-to-JSON
inside PostgreSQL) and E2 (direct response write) targeted that gap.
