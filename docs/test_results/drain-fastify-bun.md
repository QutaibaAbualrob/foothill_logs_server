# Cursor drain walk on Fastify + Bun — the adoption correctness gate

> **Item 3 below is resolved 2026-08-18.** Bun is now the shipped default and
> zero-config startup (G0) is verified; the overlay was folded into the base
> compose file and removed.

**Branch:** `perf/fastify-bun` at `cc4b75b`
**Date:** 2026-08-18, native Linux, shipped caps (api 0.5 CPU / 256 MB,
postgres 1.0 CPU / 1 GB), clean volume
**Run index:** `bench/results/2026-08-18-fastify-bun-drain/`

**Verdict: the gate passes.** Three walks over a 1,511,600-row table — one
unfiltered, one service-filtered, one unfiltered repeat — returned 0 duplicates,
0 ordering violations, reached the true end, and walked a unique-row count equal
to `COUNT(*)` every time. The blocking item on the Bun adoption decision is
cleared; the two CI items are not.

---

## 1. Why this walk had to exist

`npm run bench:drain` is a correctness gate as much as a benchmark. It
hard-fails on duplicates, ordering violations, a short walk, and a unique-row
count that misses `EXPECT_TOTAL` (`scripts/drain.mjs:147-160`). It has caught a
real defect once — 18 ordering violations across 599,635 rows, from sort columns
that were not table-qualified (`plan/HANDOFF.md:90`).

That defect only appears where a **tied timestamp group straddles a digit-length
boundary**, since that is the only place a lexicographic id comparison and an
integer one disagree. No small fixture reproduces it, and neither the 73/73
reliability matrix nor the failure drill substitutes for the walk.

Bun changes the runtime beneath `pg`; Fastify changes response serialisation.
Both sit directly on this path, and until now the walk had been run on neither.

## 2. The dataset, and the boundary it crosses

Seeded in one 45 s ingest at batch 200, concurrency 64: **1,511,600 accepted, 0
errors**, and `select count(*) from logs` returned 1,511,600 — acknowledged rows
and persisted rows agree exactly.

The table contains five tied-timestamp groups whose ids straddle a digit-length
boundary. The one that matters:

```
timestamp                    tied_rows   min(id)   max(id)
2026-08-18 08:52:15.542+00       400      999801   1000200
```

400 rows on one timestamp, spanning 999,999 → 1,000,000. The walk passed through
it. A dataset that stopped short of a million rows would not have tested this.

## 3. Result

| | unfiltered | `service=payments` | unfiltered, repeat |
| --- | ---: | ---: | ---: |
| pages | 1,512 | 378 | 1,512 |
| unique rows walked | **1,511,600** | **377,900** | **1,511,600** |
| duplicates | **0** | **0** | **0** |
| ordering violations | **0** | **0** | **0** |
| reached true end | **yes** | **yes** | **yes** |
| unique rows = `COUNT(*)` | **yes** | **yes** | **yes** |

The filtered walk's expected total is PostgreSQL's own count for that service,
377,900, not a derived share.

Stack proof, taken inside the container: `bun run src/index.ts`, Bun `1.3.14`,
`node_modules` grep returns `fastify` and not `express`. The neighbouring
`server_loger` stack was brought down first and `docker ps` was empty before
`up`.

## 4. Page latency — a screen, not a comparison

| | p50 | p95 | p99 | pages/s | rows/s |
| --- | ---: | ---: | ---: | ---: | ---: |
| unfiltered | 17.1 ms | 49.6 ms | 82.8 ms | 43.0 | 43,013 |
| `service=payments` | 18.3 ms | 46.4 ms | 78.0 ms | 44.6 | 44,607 |
| unfiltered, repeat | 14.6 ms | 40.0 ms | 76.8 ms | 54.2 | 54,211 |

**No Node baseline was taken in this session, so none of this measures what
either swap did to the read path.** It must not be set against the 87 ms page
p95 recorded for `main` earlier — different build, different session, different
table size, and the standard puts across-session noise at ~11%. The two
unfiltered walks differ by 26% between themselves on a warming cache, which is
the honest width of a single-walk number.

What can be said: **page p95 is still 5–6× the 8 ms target.** The drain-latency
miss is not closed.

## 5. The read path is application-limited

Resource capture over the repeat walk's 27.9 s window, 15 samples
(`bench/raw/2026-08-18-drain-fb-run2-resources.csv`):

| | CPU avg | CPU max | cap | peak RSS |
| --- | ---: | ---: | ---: | ---: |
| api | 46.5% | **51.1%** | 50% | **147.2 MiB** / 256 MiB |
| postgres | 35.7% | 43.6% | 100% | 319.9 MiB / 1 GB |

The api container is pinned to its cap while PostgreSQL keeps well over half of
its own in reserve, at a 99.4% buffer hit ratio (27,408,648 / 27,582,602). The
cost of a drain page is in the application, serialising 1,000 rows of JSON — the
exact work a framework swap claims to do better. **This says the headroom for
the read-path A/B is real; it does not say what either swap does with it.**

It also moves the RSS number to watch. Peak api RSS on the drain path is
**147.2 MiB against 91.3–105.8 MiB on the Bun + Fastify ingest runs** — still
57% of a 256 MB cap, but Bun's JavaScriptCore heap takes no
`--max-old-space-size` equivalent, so `mem_limit` is the only ceiling and the
drain path, not ingest, is where it comes closest.

## 6. What this does not clear

- **Item 2, CI.** `.github/workflows/ci.yml` still builds and smokes the Node
  image; under Bun it validates a path nothing runs. Unaffected by this walk.
- **Item 3, zero-config startup on Bun.** `docker-compose.bun.yml` is still an
  overlay; a bare `docker compose up` still yields Node.
- **Item 4, drain page latency.** Half of it — the correctness half — is what
  this run is. The performance half needs the Node baseline.
- **Attribute-filtered walks.** `HOT_ATTRIBUTE_KEYS` is empty in the shipped
  compose file, so the ordered partial-index path was not exercised.
- **Walks under concurrent ingest**, and anything longer than 60 s.

## CHANGES

- 2026-08-18 — created. First cursor drain walk on Fastify + Bun, at 1,511,600
  rows. All four gate conditions met on three walks; drain path shown to be
  application-limited; no Node baseline taken.
