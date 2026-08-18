# Cursor drain walk on Fastify + Bun at scale — 2026-08-18

The correctness gate that `agents.md` §Status/Next item 1 named as blocking the
Bun adoption decision. Branch `perf/fastify-bun` at `cc4b75b`, native Linux,
shipped caps (api 0.5 CPU / 256 MB, postgres 1.0 CPU / 1 GB), clean volume.

`runs.csv` indexes all four runs: one seed ingest and three walks. The raw
harness JSON and the resource CSV are in `bench/raw/`, which is gitignored —
they are pushed to the private analysis repo (see `plan/internal/SANITIZATION.md`
§7) in the session they were taken.

## What this run is, and what it is not

**It is a correctness gate.** `scripts/drain.mjs` hard-fails on duplicate rows,
ordering violations, a walk that stops short of the true end, and a unique-row
count that does not match `EXPECT_TOTAL` (`scripts/drain.mjs:147-160`). Bun
changes the runtime beneath `pg` and Fastify changes response serialisation;
both sit on this path and the walk had been run on neither. It has now been run
on both, together, at 1.5M rows.

**It is not an A/B.** No Node baseline was taken in this session, so nothing
here measures what the swap did to the read path. The page latencies below are a
single-build screen and must not be compared to the 87 ms figure recorded for
`main` in an earlier session, on a different build and a different table size —
the standard forbids exactly that comparison (~11% across-session noise, and the
row count differs).

## Result: all four conditions met, on every walk

| | unfiltered | `service=payments` | unfiltered, repeat |
| --- | ---: | ---: | ---: |
| rows in table | 1,511,600 | 1,511,600 | 1,511,600 |
| pages | 1,512 | 378 | 1,512 |
| unique rows walked | **1,511,600** | **377,900** | **1,511,600** |
| duplicates | **0** | **0** | **0** |
| ordering violations | **0** | **0** | **0** |
| reached true end | **yes** | **yes** | **yes** |
| unique rows = `COUNT(*)` | **yes** | **yes** | **yes** |

The filtered walk's expected total is PostgreSQL's own
`count(*) where service='payments'` = 377,900, not a share of the whole.

`EXPECT_TOTAL` was taken from the database, and the seed's acknowledged count
agrees with it independently: the harness reported 1,511,600 accepted with 0
errors, and `select count(*) from logs` returned 1,511,600.

## Why 1.5M rows, and the boundary this walk actually crossed

The ordering defect this gate exists to catch — 18 violations across 599,635
rows, from sort columns that were not table-qualified (`plan/HANDOFF.md:90`) —
only diverges where a **tied timestamp group straddles a digit-length
boundary**, because that is the only place a lexicographic id comparison and an
integer one disagree. No small fixture reproduces it.

This dataset contains such a group, and the walk went through it:

```
timestamp                    tied_rows   min(id)   max(id)
2026-08-18 08:52:15.542+00       400      999801   1000200
```

400 rows sharing one timestamp, spanning the 6→7 digit boundary. Five tied
groups in the table straddle a digit-length boundary in total. A walk that
stopped below 1,000,000 would not have tested this, which is why the item
specified ~1M rows or more.

## Page latency and where the read path is limited (screen, single build)

| | p50 | p95 | p99 | pages/s | rows/s |
| --- | ---: | ---: | ---: | ---: | ---: |
| unfiltered | 17.1 ms | 49.6 ms | 82.8 ms | 43.0 | 43,013 |
| `service=payments` | 18.3 ms | 46.4 ms | 78.0 ms | 44.6 | 44,607 |
| unfiltered, repeat | 14.6 ms | 40.0 ms | 76.8 ms | 54.2 | 54,211 |

The two unfiltered walks are 35.1 s and 27.9 s over identical work — a 26%
spread on a warming cache, well outside the ~6% within-session figure for
ingest. Single walks on one build: treat the range, not either number.

**Page p95 is still 5–6× the 8 ms target**, so item 4 (the drain-latency miss)
is not closed by this run.

**The new finding is that the drain path is application-limited, not
database-limited.** Resource capture over the repeat walk's 27.9 s window
(15 samples, `2026-08-18-drain-fb-run2-resources.csv`):

| | CPU avg | CPU max | cap | peak RSS |
| --- | ---: | ---: | ---: | ---: |
| api | 46.5% | **51.1%** | 50% | **147.2 MiB** / 256 MiB |
| postgres | 35.7% | 43.6% | 100% | 319.9 MiB / 1 GB |

The api container sits on its cap while postgres keeps well over half of its own
in reserve, with a 99.4% buffer hit ratio (27,408,648 / 27,582,602). The cost is
in the application — serialising 1,000-row JSON pages — which is where a
framework swap makes its largest claim. So the read-path A/B in item 4 is worth
running; this run says the headroom is there, not what either swap does with it.

**Peak api RSS on the drain path is higher than on ingest** — 147.2 MiB here
against the 91.3–105.8 MiB recorded for Bun + Fastify ingest runs. Still 57% of
the 256 MB cap, but it is the drain path, not ingest, that should be watched
against `mem_limit` on Bun.

## Compliance

The seven-point measurement standard governs A/Bs; this is a correctness gate
plus a labelled screen. What it does meet:

| # | Requirement | How |
| --- | --- | --- |
| 3 | Clean volume | `down -v` before the stack came up; `rows_before` 0, verified |
| 4 | Build verified inside the container | `bun run src/index.ts`, bun 1.3.14, `node_modules` grep returns `fastify` and not `express` |
| 6 | One stack up at a time | the neighbouring `server_loger` stack was brought down first; `docker ps` empty before `up` |
| 7 | Errors, rows, both CPUs | 0 errors on the seed; row counts above; CPU and RSS for the captured walk |

Requirements 1, 2 and 5 (interleaving, three repeats per side, one variable) do
not apply to a single-build gate and are **not** met — which is precisely why no
latency number here may be reported as a comparison.

## Not measured

- **No Node baseline for the drain**, so the read-path effect of either swap is
  still unmeasured. This is item 4 and it is unchanged by this run.
- **Attribute-filtered walks.** `HOT_ATTRIBUTE_KEYS` is empty in the shipped
  compose file, so the ordered partial-index path was not exercised.
- **Walks under concurrent ingest.** Every walk here ran against a static table.
- **Anything longer than 60 s**, on any branch.
