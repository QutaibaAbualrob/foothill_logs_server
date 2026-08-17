# Linux verification results

**Branch:** `perf/write-path-and-attribute-index` at `429012b`
**Date:** 2026-08-17
**Answers:** `plan/07-LINUX-VERIFICATION.md` (Q1–Q3) and the open follow-up lists in
`docs/conclusion.md`.

This file is uncommitted. Nothing under `src/`, `scripts/`, `plan/` or
`docker-compose.yml` was modified: `git status` shows a clean tree apart from
this file. No number below was tuned for; the two that disagree with the record
are reported as they came out.

---

## 0. Environment

| Item | Value |
| --- | --- |
| Kernel | `7.0.0-28-generic`, Ubuntu 24.04.4 — native Linux, no VM |
| CPU / RAM | 16 logical CPUs, 31 GiB |
| Docker | 29.7.2, Compose v5.3.1 |
| Node | v22.22.3 |
| Compose project | `COMPOSE_PROJECT_NAME=server_loger` exported for every command, so the container names the drill and the resource capture hardcode resolve (the directory is `foothill_logs_server`) |
| Container caps | shipped: api 0.5 CPU / 256 MB, postgres 1.0 CPU / 1 GB |
| Load generator | **co-resident with the containers** on the same host |

The host is not the machine the recorded figures came from, so **absolute
throughput is not comparable across the two runs** — only the shape of a curve,
the CPU split between containers, and pass/fail are.

Raw output is retained under `bench/raw/` (gitignored) with unique run names:
`linux-verify-*` for the verification runs, `linux-diag-*` for the one
diagnostic described in §2.3, plus the two uncommitted harnesses and the drill
console captures.

---

## 1. Correctness gates

| Gate | Result | Evidence |
| --- | --- | --- |
| `npm run typecheck` | **Pass** | exit 0 |
| `npm test` | **Pass** | 26 tests, 26 pass, **0 skipped** — including `aggregate: aligned range …` and `one retention pass drops …`, run against PostgreSQL published on `55432` via an override file |
| `npm run smoke` | **Pass** | `{"status":"ok","accepted":5,"paginated":5,"aggregateCount":5}` |
| `npm run reliability` | **Pass** | 73 checks, 0 failures |
| `npm run drill` | **FAIL — 4 checks** | reproduced twice, identically; see §1.1 |

### 1.1 The failure drill fails on Linux: 500 instead of 503 during a database outage

With PostgreSQL stopped, three endpoints return **HTTP 500** where the drill
requires 503 + `Retry-After`:

```
ok    GET /health -> 503
FAIL  GET /logs?limit=1 -> 500 (a 5xx that is not 503)
FAIL  GET /logs/aggregate?... -> 500 (a 5xx that is not 503)
FAIL  POST /logs -> 500 (expected 503)
FAIL  Retry-After header missing on 503
```

Everything else in the drill passes, both times: the container never restarts,
the service recovers by itself when PostgreSQL comes back, repeated `SIGTERM`
exits 0 after a graceful drain, and every acknowledged row is present
(`db +186000 = accepted 186000` on the first run, `db +160800 = accepted 160800`
on the second).

**Cause.** The application log during the outage shows:

```
{"event":"request_error","message":"getaddrinfo EAI_AGAIN postgres"}
```

`UNAVAILABLE_SYSTEM_ERRORS` in `src/db/pools.ts` lists `ENOTFOUND` but not
`EAI_AGAIN`. On native Linux, Docker's embedded DNS answers `SERVFAIL` for a
stopped container's name, which Node surfaces as `EAI_AGAIN`; the error
therefore misses `isDatabaseUnavailable` and falls through to the generic 500
handler.

**Confirmed by contrast.** Freezing PostgreSQL with `docker pause` — the name
still resolves, the server just never answers — produces the intended
behaviour:

```
HTTP/1.1 503 Service Unavailable
Retry-After: 1
{"error":"database is unavailable"}
```

So the 503 mapping is correct for connection loss and connect timeouts, and
misses exactly one case: the DNS record disappearing with the container. This
is why the drill passed where it was recorded and fails here — it is an
environment-dependent gap in the error mapping, and the environment where it
bites is ordinary Linux Docker.

**Not fixed.** Per `plan/07` §7 this run is verification only. The one-word fix
is obvious but it is a change to the branch under test.

**Secondary observation, same experiment.** With PostgreSQL frozen rather than
stopped, the *first* `GET /logs` never returned (curl gave up at 20 s); the next
one returned 503 in 2.0 s, the configured connect timeout. `statement_timeout`
is enforced by the server, so a query already checked out on a frozen
connection has no client-side deadline to fall back on. Not a drill check, and
not covered by any test.

---

## 2. Q1 — Is the application container really the bottleneck? **Yes.**

The finding holds on native Linux, and more strongly than it did under WSL2.

### 2.1 Container CPU, four workloads

`docker stats` percentages are per-CPU: the api container's 0.5-CPU cap shows as
a ceiling of ~50%, postgres's 1.0-CPU cap as ~100%.

| Workload | api CPU avg / max | postgres CPU avg / max | api share of its cap |
| --- | --- | --- | --- |
| Ingest, batch 200, 30 s | 43.2% / 53.7% | 31.0% / 52.5% | ~86% |
| Ingest, batch 200, sustained 221 s (60 s window) | **49.3% / 50.5%** | 44.0% / 103.7% | **~99% — pinned at the cap** |
| Cursor drain of 3.17 M rows | 44.5% / 52.7% | 23.4% / 36.4% | ~89% |
| Mixed ingest + read-after-write | 49.0% / 54.4% | 62.5% / 98.6% | ~98% |

The application sits at its cap on the write path *and* on the read path, while
PostgreSQL keeps between 40% and 75% of its own cap in reserve.

Memory is not the constraint: api peaked at 56.9 MiB of 256 MB, postgres at
312 MiB of 1 GB.

### 2.2 The `/metrics` ceiling is real, not a WSL2 artifact

`plan/07` §3 flagged the recorded 907 req/s on `/metrics` as implausible and
likely the VM network path. It reproduces here, on native Linux with ordinary
port NAT:

| App CPU cap | Concurrency | `/metrics` req/s | p50 / p95 |
| --- | --- | --- | --- |
| 0.5 (shipped) | 8 | 934.5 | 3.1 / 54.6 ms |
| 0.5 (shipped) | 32 | 1,249.8 | 13.1 / 81.4 ms |
| 2.0 (diagnostic) | 32 | **4,462.8** | 6.1 / 12.9 ms |

Raising only the CPU cap multiplies the ceiling by 3.6×. The number is the
container's CPU allowance — roughly 0.4 ms of application CPU per trivial
request — not the transport. **The hypothesis in the brief is refuted.**

### 2.3 One diagnostic: lift the cap, watch the constraint move

The api cap was raised to 2.0 CPU via an override file (shipped
`docker-compose.yml` untouched, restored immediately afterwards, verified
`nanocpus=500000000`). Nothing else changed.

| Measurement | api at 0.5 CPU | api at 2.0 CPU |
| --- | --- | --- |
| Ingest, batch 200 | 13,922 logs/s | **25,574 logs/s** (1.84×) |
| Aggregate p95 during ingestion | 562 ms | 90 ms |
| Drain pages/s | 32.2 | 43.5 |
| Drain page p95 | 87.3 ms | 39.0 ms |
| CPU during ingest | api 49.3%, pg 44.0% | api 68.9%, **pg 64.5% (max 102.6%)** |

Throughput scales with application CPU and the saturation moves to PostgreSQL.
That settles it: under the shipped caps the application container is the binding
constraint, and `docs/conclusion.md`'s addendum follow-up 4 stands rather than
being withdrawn.

Note the read path only improves 1.35× — the page targets are missed by more
than the cap explains (§4).

---

## 3. Q2 — The batch-size curve does not flatten

30 s, concurrency 96, **clean volume before each point** (one variable per run):

| Client batch size | This run (Linux) | Recorded (Windows/WSL2) | ingest p50 / p95 |
| --- | --- | --- | --- |
| 50 | 8,669 logs/s | 14,340 logs/s | 506 / 816 ms |
| 200 | 13,922 logs/s | 20,720 logs/s | 1,306 / 1,754 ms |
| 500 | 14,208 logs/s | 19,451 logs/s | 3,379 / 4,141 ms |

The shape is unchanged: a steep climb from 50 to 200, flat from 200 to 500. The
batch-50 penalty is if anything *worse* here (0.62× of batch 200, against 0.69×
on Windows), so per-request cost belongs to the service, not to the WSL2
transport. Batch 500 buys ~2% throughput for 2.6× the ingest p50 and an
aggregate p95 of 2,927 ms; 200 remains the right choice.

Absolute values are lower across the board on this host. With the load generator
co-resident and a different machine entirely, that gap is not attributable and
is not treated as a regression.

---

## 4. Q3 / drain — the honest numbers, and three missed targets

**Sustained ingestion:** 3,165,800 rows accepted in 221.1 s = **14,320 logs/s**,
0 errors, batch 200, concurrency 96, shipped caps. The 30 s runs landed at
13,922–14,532 logs/s, so the rate holds over a nearly four-minute run.

That is **below the specification's 15,000 logs/s** on this host under the 0.5-CPU
cap. With the cap at 2.0 CPU the same run reaches 25,574 logs/s.

**Drain of those 3,165,800 rows**, page size 1,000, database otherwise idle:

| | 30 s gate run | full walk | target | recorded (Windows) |
| --- | --- | --- | --- | --- |
| pages | 1,154 | 3,166 | — | — |
| rows walked | 1,154,000 | **3,165,800 = exactly the trusted count** | — | — |
| duplicates / ordering violations | 0 / 0 | **0 / 0** | 0 | 0 |
| reached true end | no (deadline) | **yes** | yes | yes |
| elapsed | 30.0 s | **98.4 s** | ≤30 s | 34.6 s |
| pages/s | 38.5 | **32.2** | ≥100 | 86.8 |
| page p50 / p95 / p99 | 17.9 / 74.9 / 92.3 ms | **18.5 / 87.3 / 107.3 ms** | p95 ≤8 ms | 16.1 ms p95 |

**Pagination is correct and the performance targets are missed by a wide
margin** — wider than the recorded run, on a slower host and with the drain
itself application-CPU-bound (api 44.5% of a 50% cap while postgres idles at
23.4%). Raising the app cap improves page p95 to 39.0 ms, still 4.9× the 8 ms
budget, so the cap is not the whole story.

---

## 5. Storage snapshot, including the GIN index

At 3,165,800 rows (5 leaf partitions, one of them hot):

| Item | Value |
| --- | --- |
| `logs` total (all partitions, incl. indexes) | 974 MB (1,021,534,208 B) |
| Indexes total | 477 MB (500,645,888 B) |
| Rollup `logs_agg_1m` | 96 kB |
| WAL LSN offset | 2,007,395,328 B |
| Buffer hit ratio | 57,859,000 / 57,977,394 = **99.80%** |

Per index on the hot partition `logs_2026_08`:

| Index | Size | Share of index bytes |
| --- | --- | --- |
| `logs_2026_08_service_level_timestamp_id_idx` | 251 MB | 51.4% |
| `logs_2026_08_attributes_idx` (GIN, `jsonb_path_ops`, `fastupdate=off`) | **131 MB** | 26.8% |
| `logs_2026_08_pkey` | 96 MB | 19.7% |

The GIN index costs ~41 bytes/row and ~13% of total `logs` size — the first time
it has been measured. It is created with `fastupdate=off` on a clean volume and
inherited by partitions created later, as the addendum claims.

**One correction to the addendum:** it says the GIN index "adds a fifth index
per partition". The shipped configuration (`HOT_ATTRIBUTE_KEYS=""`) has **three**
indexes per partition, GIN included.

Note the committed generator writes 3 attributes per entry (`trace_id`,
`region`, `retry`); `plan/05` §2 asks for 3–6 of mixed type. The GIN footprint
above is therefore a floor for a realistic payload.

---

## 6. Read-after-write freshness — the delay distribution the gate asked for

No committed harness probes at ingestion rate (`plan/07` §5.3), so one was
written for this run and retained, uncommitted, at
`bench/raw/mixed-workload.mjs`: 32 workers, each POSTing a 200-entry batch whose
first entry carries a unique `probe` attribute, then immediately issuing
`GET /logs?attr.probe=<value>&limit=1` and retrying until the row appears.
60 s against the warm 3.17 M-row database.

| Metric | Value |
| --- | --- |
| Throughput under the mixed workload | 12,700 logs/s (764,200 rows) |
| HTTP error rate | **0** |
| Probes | 3,821 — one per accepted POST |
| Found on the **first** probe | **3,821 / 3,821 = 100%**, 0 retries, 0 timeouts |
| Freshness delay p50 / p95 / p99 / max | **95.2 / 213.5 / 303.0 / 537.4 ms** |
| Probe latency p50 / p95 / p99 | 94.9 / 212.9 / 302.8 ms |
| Ingest latency p50 / p95 | 383 / 622 ms |

The freshness delay and the probe latency are the same distribution to within a
fraction of a millisecond: the row is already visible when the POST is
acknowledged, and the measured "delay" is the cost of the query that looks for
it. There is no visibility lag to measure — the floor is the read path. Recorded
Windows figures (10,062 logs/s, 100% read-after-write, 0% errors) hold.

---

## 7. Disposition of the open follow-ups

`docs/conclusion.md`, original list:

| # | Item | Status after this run |
| --- | --- | --- |
| 1 | Re-run the 3 M-row drain against the hard deadline | **Done — fails.** 98.4 s / 32.2 pages/s against ≤30 s / ≥100 pages/s. Walk itself correct |
| 2 | Keep profiling page and aggregate p95, or keep recording them as misses | **Recorded as misses.** Page p95 87.3 ms vs ≤8 ms; aggregate p95 562 ms during ingestion (90 ms with the app cap raised) |
| 3 | Repeat ingestion/drain/resource captures with unique run names and retained raw output | **Done.** 8 uniquely-named runs under `bench/raw/`, no file reused, resource CSVs each one window |
| 4 | Measure read-after-write freshness as a delay distribution | **Done — §6.** Gate can be closed: p50 95 ms, p95 214 ms, p99 303 ms, 100% first-probe visibility |
| 5 | Decide whether to rewrite public history | **Not done — owner's decision.** Untouched deliberately; see §8 |
| 6 | Treat published figures as recorded, not independently verified | Still applies to the Windows figures. The figures in this file are independently captured on this host |

`docs/conclusion.md`, addendum list:

| # | Item | Status |
| --- | --- | --- |
| 1 | Re-run the committed protocol against this configuration with retained raw output | **Done** for ingestion, drain, resources and the mixed workload. The k6 scenarios in `load/` were not run |
| 2 | Re-capture the storage snapshot with the GIN index | **Done — §5.** GIN = 131 MB of 477 MB of index at 3.17 M rows |
| 3 | Re-run the 3 M-row drain | **Done — §4** |
| 4 | Profile the application container; it is now the binding constraint | **Confirmed — §2.** It is the constraint on both paths; lifting the cap moves saturation to PostgreSQL |

---

## 8. Open, and needing a decision rather than a measurement

1. **The 503 gap (§1.1).** A real defect on Linux, deterministic, one-line
   surface (`EAI_AGAIN` missing from `UNAVAILABLE_SYSTEM_ERRORS`). Left unfixed
   because this run was scoped to verification.
2. **No client-side query deadline (§1.1, secondary).** A frozen database hangs
   a read indefinitely.
3. **Public history rewrite** — `docs/conclusion.md` follow-up 5 and `plan/07`
   §7 both say this needs an explicit decision from the repository owner. Not
   touched.
4. **15,000 logs/s is not met under the shipped 0.5-CPU api cap on this host**
   (14,320 logs/s sustained). Whether that is a cap choice or a host difference
   is a decision, not a measurement: at 2.0 CPU the same run reaches 25,574
   logs/s.
5. **`plan/07` §5.1's own warning is confirmed**: `scripts/failure-drill.sh` and
   `scripts/capture-resources.mjs` hardcode `server_loger-*`. This run set
   `COMPOSE_PROJECT_NAME` explicitly; without it the drill would have produced a
   confident, meaningless pass.

## 9. Evidence limits of this run

- The load generator ran on the same host as the containers. With 16 CPUs
  against caps of 0.5 and 1.0 the contention is mild, but it is not zero.
- `docker stats` returned ~1 sample per 2 s, so the CPU figures rest on 18–55
  samples per run; the summary JSON records actual sample counts.
- The batch-size curve wiped the volume between points; the drain, mixed
  workload and storage snapshot ran against a warm database, as marked.
- The k6 scenarios (`load/*.js`, `plan/05` §2) were not run: `scripts/`
  harnesses covered ingestion, drain, resources and the mixed workload directly.
- The mixed-workload and `/metrics` harnesses are uncommitted. They are retained
  next to their output under `bench/raw/` so the numbers can be reproduced.
- Cross-host comparison against the recorded Windows figures is confounded by
  hardware. Only shapes, ratios and pass/fail are carried across.
