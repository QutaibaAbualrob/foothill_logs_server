# Batch-33 point and the ingest CPU profile

**Revision:** `main` at `1bfb036` ("file restructure")
**Date:** 2026-08-17
**Objective:** the two measurements `agents.md` names as the next step — the
missing batch-33 point on the batch curve, and a CPU profile attached to the
ingest path — taken before any code change.

This file is uncommitted at the time of writing. No tracked file was modified.

---

## 0. Environment

Identical to `main-linux-results.md` §0: Ubuntu 24.04.4 on kernel `7.0.0-28-generic`,
16 logical CPUs, 31 GiB, Docker 29.7.2, Node v22.22.3, load generator co-resident
with the containers. Container caps `api` 0.5 CPU / 256 MB, `postgres` 1.0 CPU /
1 GB, verified as `nanocpus: 500000000` before and after every run except the
explicitly marked 4.0-CPU control.

`docker stats` percentages are per-CPU, so the api container's 0.5-CPU cap
appears as a ceiling of ~50%.

---

## 1. The batch-33 point

Run exactly as `agents.md` specifies — 60 s, concurrency 96, batch 33 — from a
clean volume (`docker compose down -v`), with resource sampling attached.

| Metric | Value |
| --- | --- |
| Throughput | **8,169.8 logs/s** |
| Accepted | 497,970 |
| Errors | **0** |
| Ingest p50 / p95 / p99 | 378.2 / 603.8 / 706.8 ms |
| Aggregate p95 (56 probes) | 203.5 ms |
| Rows before / after | 0 / 497,970 |
| api CPU avg / max | **47.9% / 51.1%** of a 50% cap (~96% utilised) |
| postgres CPU avg / max | 39.7% / 85.3% of a 100% cap |

Raw: `bench/raw/batch33.json`, `bench/raw/batch33-resources.csv`,
`bench/raw/batch33-summary.json`.

**The application container is the constraint at batch 33**, not PostgreSQL: api
sits at 96% of its cap while postgres keeps ~60% of its own in reserve.

### 1.1 The curve, re-measured in one session

The recorded curve in `main-linux-results.md` §3 could not be extended by simply
appending a point — see §2. All four points below were taken in one continuous
session on one database, batch 33 first, so they are comparable to each other.
30 s each except batch 33 (60 s, as specified). 0 errors throughout.

| Batch | Rows before | Throughput | requests/s | ingest p50 / p95 / p99 | aggregate p95 |
| --- | ---: | ---: | ---: | --- | ---: |
| **33** | 0 | **8,169.8 logs/s** | **247.6** | 378 / 604 / 707 ms | 204 ms |
| 50 | 497,970 | 9,504.1 logs/s | 190.1 | 487 / 790 / 916 ms | 263 ms |
| 200 | 786,920 | 14,487.4 logs/s | 72.4 | 1,285 / 1,634 / 2,236 ms | 606 ms |
| 500 | 1,224,320 | 15,216.6 logs/s | 30.4 | 3,075 / 3,712 / 3,937 ms | 1,307 ms |

Raw: `bench/raw/batch33.json`, `bench/raw/batch33-curve-b{50,200,500}.json`.

**What batch 33 answers.** Requests/s falls 8.1× from batch 33 to batch 500
while throughput rises only 1.86×. Fitting `latency = a + b · batch` to the
p50 column gives roughly **a ≈ 187 ms fixed per request and b ≈ 5.8 ms per log**
(predicts 476 ms at batch 50 against 487 measured, and 1,342 ms at batch 200
against 1,285 measured). Two consequences:

- At batch 33 about **half of each request's latency is the size-independent
  term**; at batch 500 it is under 6%. Small batches are dominated by
  per-request cost.
- The per-log term implies a ceiling of `96 / 5.8 ms ≈ 16,600 logs/s` at this
  concurrency, which is where batch 500 (15,217) is already flattening.

**Do not read `a ≈ 187 ms` as framework overhead.** It is measured at a fixed
96 in-flight requests, so it is dominated by queueing, not by per-request CPU.
The profile in §3 is what actually apportions the per-request cost, and it puts
the Express layer at single-digit percent.

Batch 500 exceeded the 15,000 logs/s specification target here (15,217), but at
an aggregate p95 of 1,307 ms it breaks the "< 1 s aggregate" requirement, and at
3.7 s ingest p95. It is not a passing configuration.

---

## 2. A claim in `main-linux-results.md` §3 that its own evidence does not support

§3 states "clean volume before each point" for the batch-size sweep. The result
files say otherwise:

| Point | started | ended | gap to next start |
| --- | --- | --- | ---: |
| `main-sweep-b50.json` | 14:31:35.184Z | 14:32:05.446Z | **17 s** |
| `main-sweep-b200.json` | 14:32:22.646Z | 14:32:52.992Z | **10 s** |
| `main-sweep-b500.json` | 14:33:02.722Z | 14:33:33.840Z | — |

A `docker compose down -v` plus postgres initdb, healthcheck and migration takes
**37.2 s** measured on this host today. It cannot fit in a 10-second gap. The
recorded sweep therefore ran back-to-back against a growing database — b50
started on roughly the 430,800 rows the preceding `main-b200-bench` run had just
inserted, and each later point started on more.

That does not invalidate the recorded numbers as a sequential curve; it means
the stated method is wrong, and points measured at different table sizes were
presented as measured at the same one. The curve in §1.1 above records rows
before each point instead.

The same discrepancy applies to `linux-verify-sweep-*` (gaps of 13 s and 15 s).

---

## 3. The CPU profile

**Method.** `--cpu-prof --cpu-prof-dir=/prof --cpu-prof-interval=500` added to
`NODE_OPTIONS` through a measurement-only override
(`bench/raw/prof.override.yml`); the shipped `docker-compose.yml` was never
edited, and caps were re-verified afterwards. The profile is written when the
process exits cleanly, so each run ends with `docker compose stop api`
(SIGTERM → graceful shutdown → **exit code 0**). Profiles land in
`bench/raw/prof/`. The main process is pid 1; the many small profiles in the
same directory are the 3-second healthcheck subprocesses and are not analysed.

Shares below are of **non-idle sampled time**. Note `--cpu-prof` costs about 19%
throughput (batch 33: 6,572 logs/s profiled vs 8,169.8 unprofiled; batch 200:
11,756 vs 14,487), so the profile attributes cost, it does not measure it.

| Bucket | batch 33, 0.5 CPU | batch 200, 0.5 CPU | batch 200, 4.0 CPU (control) |
| --- | ---: | ---: | ---: |
| **(garbage collector)** | **30.0%** | **43.2%** | **33.9%** |
| **App code** (`dist/src/…`) | 19.0% | 25.3% | **37.5%** |
| `body-parser` (JSON parse) | 7.7% | 8.1% | 8.2% |
| Express + router | **8.9%** | 2.9% | **2.4%** |
| node `_http_*` builtins | 6.8% | 3.3% | 2.9% |
| `raw-body` + `type-is` + `parseurl` + `content-type` | 3.6% | 1.3% | 0.5% |
| `pg` | 0.2% | <0.2% | <0.2% |
| idle (share of wall) | 31.6% | 9.2% | 43.0% |
| on-CPU wall | 50.0 s | 58.7 s | 36.6 s |

Top app functions, by self time as a share of non-idle time:

| Function | batch 33 | batch 200 |
| --- | ---: | ---: |
| `computeRollups` (`ingest/repository.js:51`) | 5.5% | **9.6%** |
| `parse` (`body-parser/lib/types/json.js:76`) | 5.6% | 7.5% |
| `validateEntry` (`ingest/validation.js:26`) | 4.8% | 6.0% |
| `csv` (`ingest/repository.js:46`) | 3.1% | 5.2% |
| `validateAttributes` (`ingest/validation.js:71`) | 3.4% | — |

Raw: `bench/raw/prof/b33/`, `bench/raw/prof/b200-capped/`, `bench/raw/prof/`,
with `bench/raw/batch{33,200}-profiled*.json`.

### 3.1 This settles the open question in `07-LINUX-VERIFICATION.md` §Q1

Q1 recorded that direct per-log costs are small — `JSON.parse` + validation
2.96 µs/log, CSV row building 0.07 µs/log, together roughly 6% of one core —
and asked what consumes the other ~45% of the cap. The answer is
**garbage collection and, at small batches, the HTTP request stack**:

- GC is the largest or second-largest consumer in every profile taken.
- The per-request HTTP cost is real and batch-dependent: Express + router +
  `_http_*` + the small header/body helpers total **19.3% at batch 33** and
  **7.5% at batch 200**. That is the per-request overhead the batch curve
  implies, now attributed.
- `pg` is ~0.2%. The database client costs the application nothing measurable.

---

## 4. The GC number: a conflict, and how it was resolved

Three measurements of the same thing disagreed, so the first reading was not
banked:

| Measurement | GC share |
| --- | ---: |
| CPU profile, batch 200, 0.5 CPU | 43.2% of non-idle time |
| `--trace-gc` pause sum, batch 200, 0.5 CPU | 33.8% of wall |
| V8's own `current mu`, same run | **6.4%** |

Two facts made the wall-clock figures suspect. Peak heap was **43.0 MB against
a 192 MB cap with zero mark-compacts** — no heap pressure at all — yet the
average *scavenge* took 5.67 ms and the worst took 93.8 ms, which is absurd for
a 43 MB young generation. That is the signature of CFS throttling: at a
0.5-CPU quota the process is descheduled mid-work and the stall is smeared onto
whichever frame was executing when the sample landed.

**The control:** the same profile with the cap raised to 4.0 CPU, where nothing
throttles. GC came out at **33.9%** — down from 43.2%, but still the second
largest consumer. So roughly 9 points of the capped figure was throttle smear
and the rest is real. An independent arithmetic check agrees: 3,845 scavenges
over 64.4 s at ~3 ms each ≈ 11.5 s, against the profile's measured 12.41 s.

`current mu = 0.936` remains unexplained and is the outlier of the four figures.
It is recorded here rather than dropped.

**Conclusion, stated at the confidence the evidence supports:** GC is a genuine
major cost, roughly a third of on-CPU time, and it is driven by **allocation
churn — 59.7 scavenges/second — not by heap exhaustion.** Raising
`--max-old-space-size` would not address it; allocating less per request would.

Raw: `bench/raw/batch200-gctrace.log`, `bench/raw/batch200-gctrace2.json`,
`bench/raw/batch200-profiled-4cpu.json`, `bench/raw/prof-2cpu.override.yml`.

---

## 5. What this implies for the framework decision

`agents.md` sets the path after these measurements: try Fastify on Node on a
branch, then Fastify + Bun, and "commit to main only if the measurements show
it's worth it." The measurements now exist. They are an input to that decision,
not a reversal of it — the decision is the owner's.

- **A framework swap targets Express + router: 8.9% of non-idle time at batch
  33, and 2.4–2.9% at batch 200.** Fastify would reclaim a fraction of that, not
  all of it. It does not remove JSON parsing (8.2%, which any framework pays),
  node's `_http_*` layer (2.9%), GC, or app code.
- **The larger targets are GC (~34%) and app code (~37% unthrottled)**, and the
  two are related: `computeRollups` (9.6%) and `csv` (5.2%) are the top app
  functions and both build strings and objects per log — likely direct
  contributors to the 59.7 scavenges/second.
- The batch-33 point shows per-request overhead matters most exactly where
  throughput is worst. At the batch sizes that reach target throughput
  (200–500), the framework layer is under 3%.

On this evidence the Node-side Fastify swap looks low-yield, and allocation
reduction in `computeRollups`/`csv` looks like the higher-return experiment.
Bun is a separate question these measurements do not answer: it changes the JSON
parser and the GC as well as the framework, which is most of the cost here.

---

## 6. Verification after the measurement runs

The shipped configuration was restored and re-checked:

| Check | Result |
| --- | --- |
| `nanocpus` / memory | `500000000` / `268435456` — unchanged |
| `NODE_OPTIONS` in container | `--max-old-space-size=192` — profiler flags gone |
| Container command | `node dist/src/index.js` — unchanged |
| `npm run smoke` | **Pass** — `{"status":"ok","accepted":5,"paginated":5,"aggregateCount":5}` |
| `npm run reliability` | **Pass** — 73 checks, **0 failures** |
| `git status` on tracked files | clean |

---

## 7. Raw files

All under `bench/raw/` (gitignored), create-only, one run per name:

- `batch33.json`, `batch33-resources.csv`, `batch33-summary.json` — the §1 point
- `batch33-curve-b50.json`, `-b200.json`, `-b500.json` — the §1.1 curve
- `batch33-profiled.json`, `batch200-profiled.json`, `batch200-profiled-4cpu.json`
- `batch200-gctrace2.json`, `batch200-gctrace.log`
- `prof/b33/`, `prof/b200-capped/`, `prof/` — `.cpuprofile` files, pid 1 is the service
- `prof.override.yml`, `prof-2cpu.override.yml`, `gctrace.override.yml` — measurement-only overrides
- `batch200-gctrace.INVALID-harness-error.json` — a discarded run, retained and
  named as invalid: `--trace-gc` is not permitted in `NODE_OPTIONS` (unlike
  `--cpu-prof`), so the container crash-looped and the run recorded 0 accepted
  and 133,276 errors. It measures the harness mistake, not the service.

---

## 8. Reproduce

```bash
export COMPOSE_PROJECT_NAME=server_loger

# §1 batch-33 point, clean volume
docker compose down -v && docker compose up -d --build --wait
RUN_NAME=batch33 DURATION_SECONDS=60 npm run bench:capture &
BASE_URL=http://127.0.0.1:8080 DURATION_SECONDS=60 CONCURRENCY=96 BATCH_SIZE=33 \
  RESULT_PATH=bench/raw/batch33.json node scripts/benchmark.mjs
wait

# §3 CPU profile
docker compose down -v
docker compose -f docker-compose.yml -f bench/raw/prof.override.yml up -d --wait
BASE_URL=http://127.0.0.1:8080 DURATION_SECONDS=60 CONCURRENCY=96 BATCH_SIZE=33 \
  RESULT_PATH=bench/raw/batch33-profiled.json node scripts/benchmark.mjs
docker compose -f docker-compose.yml -f bench/raw/prof.override.yml stop api  # flushes the profile

# restore the shipped stack and re-check the gates
docker compose down -v && docker compose up -d --wait
BASE_URL=http://127.0.0.1:8080 npm run smoke
BASE_URL=http://127.0.0.1:8080 npm run reliability
```
