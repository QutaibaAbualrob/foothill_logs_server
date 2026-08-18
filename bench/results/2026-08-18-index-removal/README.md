# 2026-08-18 — pricing the two zero-scan indexes

Per-run index for the 30 runs behind the decision to **drop
`logs_service_level_page_idx` and keep the attributes GIN**.
Narrative: `docs/test_results/index-removal.md`. Migration:
`src/db/migrations/004_drop_service_level_page_idx.sql`. Raw output (JSON,
resource CSVs, summaries) is in the private analysis repo under
`evidence/2026-08-18-index-removal/` — see `plan/internal/SANITIZATION.md` §7.

## What this set measures

`docs/test_results/postgres-profile.md` found 116 MB and 57 MB of index
maintained on every inserted row for **zero scans**, inside the `COPY` that
owns 71.3% of database time. Those indexes are *pure write cost under this
query mix* — which is not the same as useless, because this workload never
filters by `service`, `level`, or an attribute.

So each index was measured **against the query shape it exists to serve**, not
against the default workload. That distinction is the whole result: the default
unfiltered walk uses neither index and would have reported "no regression" for
both, which is exactly the trap `plan/05-BENCHMARK-PROTOCOL.md` §1.9 now exists
to prevent.

## Cells

| `cell` | What varies | Read shape | Offered rate |
| --- | --- | --- | ---: |
| `screen` | **both** indexes at once | unfiltered walk | 15,000 /s |
| `R1` | `logs_service_level_page_idx` | service-filtered walk | 15,000 /s |
| `R2` | attributes GIN | selective attribute point lookup | 15,000 /s |
| `S1` | `logs_service_level_page_idx` (GIN present both sides) | unfiltered walk | 30,000 /s (b33), 45,000 /s (b200) |

`screen` rows are marked `status=screen`, not `verified`: they move two
variables at once by design, to decide whether a full matrix was justified. Do
not quote them as evidence for either index individually.

## Result

| | Baseline | Dropped |
| --- | ---: | ---: |
| **R1** service-filtered walk | 12.6–13.1 pages/s | 12.4–14.4 — **no regression** |
| **R2** attribute lookup p50 | 2.4–2.7 ms | 106.1–110.6 ms — **42.7×** |
| **S1** throughput, batch 33 | 22,747–23,073 /s | 24,320–26,622 — **+12.4%** |
| **S1** throughput, batch 200 | 22,222–24,724 /s | 28,434–30,679 — **+25.1%** |
| **S1** WAL bytes/row | 707–711 | 575–583 — **−18%** |

## Reading the columns

| Column | Meaning |
| --- | --- |
| `wal_bytes_per_row` | **Use this, not absolute WAL.** The sides process different row counts once throughput diverges, so absolute WAL is not comparable |
| `pg_cpu_avg` | Percentages above 100 are peaks above PostgreSQL's own 1.0 CPU cap |
| `shed` | Batches the open-loop client could not dispatch. Large values in `S1` are **expected** — the offer is deliberately above capacity |
| `read_pages_s` | In `R2` this is point lookups per second, not pages of a walk |
| `status` | `verified` = all eight standard rules met; `screen` = two variables |

## Validity and caveats

- 3 interleaved pairs per cell, clean volume per run (`rows_before: 0`), build
  verified in-container every run, one stack at a time, zero ingest or read
  errors in all 30 runs.
- **`screen` and `S1` were run at different offered rates** (15,000 vs
  30,000/45,000 /s) and are not comparable across sections.
- Nothing exceeds 60 s of load — no soak, no sustained-RSS figure.
- One host, one session.
- R1's "no regression" rests on the read set being RAM-resident (96.2% buffer
  hit ratio). A table much larger than memory, paged heavily by service, could
  reverse it.
- No attribute-filtered *walk* was run — the generator emits no mid-selectivity
  attribute key, so such a walk would match every row or exactly one. R2 uses
  the point-lookup shape that migration `002` justified the GIN with.
- Six read-half runs were lost to a power cut and re-run. The replacement R2
  pair reproduced the survivors closely (p50 106.1 ms against 106.7 and 110.6).
