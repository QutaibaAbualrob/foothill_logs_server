# Linux results — `main`

**Revision:** `main` at `284c978` ("Classify every getaddrinfo failure as the
database being unavailable")
**Date:** 2026-08-17
**Objective:** measured results on native Linux. Every number below is what this
host produced; nothing is compared against a previously recorded run, and
nothing was tuned for.

This file is uncommitted. No tracked file was modified — `git status` shows a
clean tree apart from this file.

---

## 0. Environment

| Item | Value |
| --- | --- |
| Kernel | `7.0.0-28-generic`, Ubuntu 24.04.4 — native Linux, no VM |
| CPU / RAM | 16 logical CPUs, 31 GiB |
| Docker | 29.7.2, Compose v5.3.1 |
| Node | v22.22.3 |
| Compose project | `COMPOSE_PROJECT_NAME=server_loger` exported for every command (the scripts hardcode those container names; the directory is `foothill_logs_server`) |
| Container caps | api 0.5 CPU / 256 MB, postgres 1.0 CPU / 1 GB |
| Load generator | co-resident with the containers on the same host |
| Image | rebuilt from this revision; every run started from `docker compose down -v` unless marked warm |

`docker stats` percentages are per-CPU, so the api container's 0.5-CPU cap
appears as a ceiling of ~50% and postgres's 1.0-CPU cap as ~100%.

Raw output is retained under `bench/raw/` (gitignored) as `main-*`: benchmark
and drain JSON, resource CSVs and summaries, and the two harnesses used for the
mixed workload and the `/metrics` ceiling.

---

## 1. Correctness gates

| Gate | Result | Detail |
| --- | --- | --- |
| `npm run typecheck` | **Pass** | exit 0 |
| `npm test` | **Pass** | **32 tests, 32 pass, 0 skipped** — including both integration tests (`aggregate: aligned range …`, `one retention pass drops …`), run against PostgreSQL published on `55432` via an override file |
| `npm run smoke` | **Pass** | `{"status":"ok","accepted":5,"paginated":5,"aggregateCount":5}` |
| `npm run reliability` | **Pass** | 73 checks, 0 failures |
| `npm run drill` | **Pass** | all checks green |

### 1.1 Failure drill, check by check

| Check | Result |
| --- | --- |
| `GET /health` during outage | 503 |
| `GET /logs` during outage | **503** |
| `GET /logs/aggregate` during outage | **503** |
| `POST /logs` during outage | **503** |
| `Retry-After` on 503 | present (`Retry-After: 1`) |
| Application container restarts | 0 — same process throughout |
| Self-recovery after PostgreSQL restarts | health 200, `GET /logs` 200, `POST /logs` 200 |
| Repeated `SIGTERM` | exit code 0 after a graceful drain |
| Acknowledged rows persisted | **`db +170000 = accepted 170000`** |
| Graceful shutdown event logged | yes |
| Stack healthy at the end | health 200 |

Every endpoint degrades to 503 with `Retry-After` while PostgreSQL is stopped;
no 500s and no 5xx that is not 503.

---

## 2. Where the CPU goes

### 2.1 Container CPU, four workloads

| Workload | api CPU avg / max | postgres CPU avg / max | api share of its cap |
| --- | --- | --- | --- |
| Ingest, batch 200, 30 s | 42.4% / 52.9% | 40.2% / 89.2% | ~85% |
| Ingest, batch 200, sustained 231 s (60 s window) | **49.6% / 53.7%** | 42.2% / 92.2% | **~99%** |
| Cursor drain of 3.22 M rows | 44.2% / 53.7% | 22.7% / 34.2% | ~88% |
| Mixed ingest + read-after-write | 49.0% / 52.9% | 66.7% / 99.9% | ~98% |

The application container sits at or near its 0.5-CPU cap on the write path and
on the read path; PostgreSQL keeps between a third and three quarters of its own
cap in reserve on all four.

Memory is not a constraint: api peaked at 53.4 MiB of 256 MB, postgres at
310.7 MiB of 1 GB.

### 2.2 `/metrics` ceiling — a route that touches no database

| App CPU cap | Concurrency | req/s | p50 / p95 |
| --- | --- | --- | --- |
| 0.5 (shipped) | 8 | 1,121.0 | 3.0 / 46.2 ms |
| 0.5 (shipped) | 32 | 1,178.6 | 13.2 / 84.1 ms |
| 2.0 | 32 | **4,524.5** | 6.0 / 12.7 ms |

~1,150 req/s at the shipped cap, 3.8× that at 4× the CPU — roughly 0.4 ms of
application CPU per trivial request.

### 2.3 The same runs with the api cap at 2.0 CPU

Override file only; shipped `docker-compose.yml` untouched and restored
immediately afterwards (verified `nanocpus=500000000`).

| Measurement | api 0.5 CPU | api 2.0 CPU |
| --- | --- | --- |
| Ingest, batch 200 | 13,987 logs/s | **25,085 logs/s** (1.79×) |
| Aggregate p95 during ingestion | 679 ms | 69 ms |
| Drain pages/s | 32.8 | 51.6 |
| Drain page p95 | 87.4 ms | 23.7 ms |
| `/metrics` | 1,179 req/s | 4,525 req/s |
| CPU during ingest | api 49.6%, pg 42.2% | api 75.7% (max 113.0%), **pg 64.1% (max 100.5%)** |

Throughput scales with application CPU on both paths, and at 2.0 CPU the
saturation point moves to PostgreSQL.

---

## 3. Batch-size curve

30 s, concurrency 96, clean volume before each point, 0 HTTP errors throughout.

| Client batch size | Throughput | ingest p50 / p95 / p99 | aggregate p95 |
| --- | --- | --- | --- |
| 50 | 8,292 logs/s | 549 / 865 / 907 ms | 299 ms |
| 200 | 12,582 logs/s | 1,469 / 2,130 / 2,447 ms | 631 ms |
| 500 | 13,803 logs/s | 3,526 / 3,999 / 6,911 ms | 1,215 ms |

Batch 200 is 1.52× batch 50. Batch 500 adds a further 10% throughput for 2.4×
the ingest p50 and roughly double the aggregate p95.

A separate batch-200 run taken with resource sampling attached reached
13,987 logs/s, so the batch-200 point sits in the 12.6k–14.0k band across
repeats.

---

## 4. Sustained ingestion and the cursor drain

**Sustained ingestion:** 3,220,200 rows accepted in 230.8 s = **13,951 logs/s**,
0 errors, batch 200, concurrency 96. Ingest p50 1,350 ms, p95 1,777 ms,
p99 1,911 ms. Aggregate p95 632 ms across 178 probes during ingestion.

**Drain of those 3,220,200 rows**, page size 1,000, database otherwise idle:

| | 30 s deadline run | full walk |
| --- | --- | --- |
| pages | 1,111 | 3,221 |
| rows walked | 1,111,000 | **3,220,200 — exactly the trusted `count(*)`** |
| duplicates | 0 | **0** |
| ordering violations | 0 | **0** |
| reached true end | no (stopped at deadline) | **yes** |
| elapsed | 30.04 s | **98.2 s** |
| pages/s | 37.0 | **32.8** |
| rows/s | 36,983 | 32,791 |
| page p50 / p95 / p99 | 18.1 / 78.6 / 102.8 ms | **18.1 / 87.4 / 107.7 ms** |

The walk is exact — every accepted row visited once, in strict order — and takes
98.2 s. With the api cap at 2.0 CPU the same walk over 3,985,400 rows finished in
77.2 s at 51.6 pages/s with a page p95 of 23.7 ms, also with 0 duplicates and 0
ordering violations.

---

## 5. Storage at 3,220,200 rows

| Item | Value |
| --- | --- |
| `logs` total, all partitions incl. indexes | 991 MB (1,039,335,424 B) |
| Indexes total | 486 MB (509,206,528 B) |
| Rollup `logs_agg_1m` | 120 kB |
| WAL LSN offset | 2,040,028,928 B |
| Buffer hit ratio | 58,900,773 / 59,014,813 = **99.81%** |
| Leaf partitions | 5 (one hot) |

Per index on the hot partition `logs_2026_08` — three indexes per partition in
the shipped configuration (`HOT_ATTRIBUTE_KEYS=""`):

| Index | Size | Share of index bytes | Bytes/row |
| --- | --- | --- | --- |
| `logs_2026_08_service_level_timestamp_id_idx` | 256 MB | 52.7% | 83 |
| `logs_2026_08_attributes_idx` — GIN, `jsonb_path_ops`, `fastupdate=off` | 132 MB | 27.3% | 43 |
| `logs_2026_08_pkey` | 97 MB | 20.0% | 32 |

Index bytes are 49% of total `logs` size; the attribute GIN index is 13% of it.

---

## 6. Read-after-write, probed after every accepted POST

Harness (`bench/raw/mixed-workload.mjs`, uncommitted, retained with its output):
32 workers, each POSTing a 200-entry batch whose first entry carries a unique
`probe` attribute, then immediately issuing
`GET /logs?attr.probe=<value>&limit=1` and retrying until the row appears. 60 s
against the warm 3.22 M-row database.

| Metric | Value |
| --- | --- |
| Throughput under the mixed workload | 12,703 logs/s (765,200 rows) |
| HTTP error rate | **0** |
| Probes | 3,826 — one per accepted POST |
| Found on the **first** probe | **3,826 / 3,826 = 100%** (0 retries, 0 timeouts) |
| Freshness delay p50 / p95 / p99 / max | **97.7 / 209.6 / 295.8 / 594.8 ms** |
| Probe query latency p50 / p95 / p99 | 97.4 / 209.3 / 295.4 ms |
| Ingest latency p50 / p95 / p99 | 382 / 655 / 866 ms |

The freshness delay and the probe latency are the same distribution to within a
fraction of a millisecond: the row is already visible when the POST is
acknowledged, so what the delay measures is the cost of the query that looks for
it, not a visibility lag.

---

## 7. Results against the project's stated targets

| Target | Source | Result | |
| --- | --- | --- | --- |
| 15,000 logs/s ingestion | specification | 13,951 logs/s sustained (14.0k peak 30 s run) | **miss** |
| Aggregate query < 1 s | specification | p95 632–679 ms during active ingestion | **met** |
| Aggregate p95 in double-digit ms | plan target | 632 ms (69 ms at 2.0 CPU) | **miss** |
| Full cursor drain within 30 s | plan target | 98.2 s | **miss** |
| ≥100 drain pages/s | plan target | 32.8 pages/s | **miss** |
| Page p95 ≤ 8 ms | plan target | 87.4 ms (23.7 ms at 2.0 CPU) | **miss** |
| Pagination exact — no skips, no repeats, true end | gate G3 | 3,220,200 / 3,220,200 unique, 0 duplicates, 0 ordering violations | **met** |
| No acknowledged row lost across `SIGTERM` | gate | `db +170000 = accepted 170000` | **met** |
| Every endpoint degrades to 503 + `Retry-After` | gate | all four endpoints 503 | **met** |
| Read-after-write visibility | gate | 100% on the first probe; p95 delay 210 ms | **met** |
| Correctness suites | gates | typecheck 0, 32/32 tests, smoke ok, 73/73 reliability | **met** |

All four performance misses move substantially when the application container's
CPU cap is raised, and none of them is a PostgreSQL saturation: throughput
targets on this host are bounded by the 0.5-CPU api cap.

---

## 8. How these numbers were taken

- One benchmark at a time on an otherwise idle host; the load generator ran on
  that same host, with 16 CPUs against caps of 0.5 and 1.0.
- The batch-size sweep wiped the volume between points. The drain, storage
  snapshot, mixed workload and 2.0-CPU runs ran against a warm database, as
  marked.
- `docker stats` returned roughly one sample every 2 s, so CPU figures rest on
  18–55 samples per run; each summary JSON records its own sample count and
  actual start/end times.
- Every raw path is create-only with a unique run name; no file was appended to
  or reused.
- The k6 scenarios in `load/` were not run — `scripts/` harnesses covered
  ingestion, drain, resources and the mixed workload directly.
- The committed generator writes 3 attributes per entry; the mixed harness
  writes 4 plus a probe key, mixing string, number and boolean values, with a
  backdated fraction and a share of deliberately invalid entries.
- The `/metrics` and mixed-workload harnesses are uncommitted and retained
  beside their output under `bench/raw/`.
