# Task Board

Ordered, dependency-aware task list for the 6-hour build.

**Legend**
`Owner` — agent role from `03-AGENTS.md`
`Box` — timebox in minutes; overrun triggers the fallback ladder
`DoD` — definition of done; the task is not complete until this is literally true

Roles: **INFRA**, **CORE** (ingest), **QUERY** (read path), **BENCH**, **DOCS**.

---

## Phase 0 — Repository shape and hygiene · H+0:00 → H+0:30

### T01 · Promote the application to the repository root · INFRA · 12 min
The spec requires `docker compose up` at the repository root (§7, §33) and CI
must live at `.github/workflows/` from the root (§39). Both currently sit one
level down.

- Move `workshop/*` (including dotfiles) to `E:\server_loger\`.
- Delete the now-empty `workshop/`.
- Fix any path assumption in `migrate.ts` (it resolves migrations from
  `process.cwd()`), the `Dockerfile` build context, and `docker-compose.yml`.

**DoD:** `package.json`, `docker-compose.yml`, `Dockerfile`, `.github/`, `src/`
are all at the repository root; `npm run build` succeeds from the root.

### T02 · Root ignore rules · INFRA · 5 min
- `.gitignore` covers build output, dependencies, environment files, benchmark
  artefacts and scratch directories.
- `.dockerignore` excludes `node_modules`, `.git`, scratch directories, `bench`,
  `plan`, and the PDF library — a fat build context cache-busts every build.

**DoD:** `git status --ignored --porcelain` confirms every scratch and build
path is ignored; `docker build` context size is under ~5 MB.

### T03 · Git history hygiene · INFRA · 8 min
Resolve the tracked PDF library (~59 MB) per `06-RELEASE-CHECKLIST.md` §2,
and confirm nothing unintended has ever been committed.

**DoD:** `git log --all --name-only --pretty=format: | sort -u` contains only
files that belong in the release; `git count-objects -vH` shows a small pack.

### T04 · Clean-clone boot · INFRA · 5 min
Clone the repository to a scratch directory and run `docker compose up` with no
`.env` and no arguments.

**DoD:** `GET /health` returns `200` from a clean clone. **This is gate G0.**

---

## Phase 1 — Close the contract · H+0:30 → H+1:45

T05–T08 are independent and may run in parallel.

### T05 · Ingestion contract · CORE · 25 min
- `POST /logs`: `{accepted, rejected:[{index, reason}]}`; `200` when ≥1 entry is
  accepted; `400` when all are rejected, JSON is malformed, or the top-level
  shape is wrong.
- Validation mirrors every column constraint, including rejection of characters
  PostgreSQL `text` cannot store.
- Timestamp normalised once to a canonical UTC instant, reused for the row, the
  rollup bucket, and the cursor. Explicit offset required.
- Backpressure returns `503` + `Retry-After`, never a false `200`.

**DoD:** unit tests cover mixed-validity batches with preserved original
indexes, an all-invalid batch, malformed JSON, a null byte in each string field,
a nested-object attribute, an array attribute, and a timestamp more than five
minutes in the future.

### T06 · Query contract · QUERY · 30 min
- All filters from spec §13, freely combinable.
- `limit` default 100, max 1000, strict integer parsing.
- `ORDER BY timestamp DESC, id DESC`; `limit + 1` probe; cursor anchored to the
  last returned row.
- `next_cursor` is `null` — present and null, not omitted — at the true end.
- Response shape exactly `{logs: [...], next_cursor: string|null}`; `id` as a
  string; attribute values keep their original JSON types.

**DoD:** unit tests for cursor round-trip at microsecond precision, tied
timestamps, tampered signature, cross-filter replay, empty result set.

### T07 · Aggregate contract · QUERY · 30 min
- Required `since`, `until`, `bucket`; optional `group_by`; all allow-listed.
- Rollup interior + exact raw edge slices for unaligned ranges.
- Raw fallback whenever `q` or `attr.<key>` is present.
- `{buckets:[{start, group, count}]}`, ascending by start, empty buckets
  omitted, `group: null` without `group_by`. Counts are `BIGINT`-safe.

**DoD:** a unit test proves an unaligned range does not count a whole edge
minute, and that rollup and raw paths return identical counts for the same
filter set.

### T08 · Retention and health · CORE · 20 min
- `RETENTION_DAYS` strictly parsed, default 30.
- Partitions pre-created across the retention window plus a forward margin.
- Drop whole expired partitions; sweep boundary and `DEFAULT` rows in bounded
  `SKIP LOCKED` batches; apply the same expiry to the rollup table.
- Advisory-locked, on the maintenance pool.
- `/health` returns `200` only after migrations have applied and ingest is ready,
  and it never queues behind DDL.

**DoD:** an integration test seeds an expired partition, runs one retention
cycle, and asserts both raw rows and rollup counts are gone.

### T09 · Contract smoke script · INFRA · 15 min
A single script that exercises all four endpoints against a running stack:
happy paths, every `400` case in spec §17, pagination walk, aggregate with and
without grouping, and a read-after-write freshness assertion.

**DoD:** `npm run smoke` exits 0 against `docker compose up`; exits non-zero if
any assertion fails. **This is gate G1.**

---

## Phase 2 — Reliability · H+1:45 → H+2:15

### T10 · Edge-case hardening · CORE + QUERY · 20 min
Work the G2 matrix in `04-VERIFICATION-GATES.md`. Specifically:

- Literal `%`, `_`, `\` in `q` must not act as wildcards.
- Malformed / tampered / cross-filter cursor → `400`, never `500`.
- `limit=50x`, `limit=0`, `limit=1001`, `limit=1e3` → `400`.
- `until` < `since` → `400`; empty range → `200` with empty results.
- Unsupported level, unsupported bucket, unsupported `group_by` → `400`.
- Duplicate query parameters handled deterministically.

**DoD:** every row of the G2 matrix passes, asserted by the smoke script.

### T11 · Failure-mode handling · CORE · 10 min
- Database unreachable, statement timeout, pool acquire timeout → `503` with
  `Retry-After`, never `500`, never a crash.
- Unhandled rejection and uncaught exception handlers log and stay alive where
  safe; the restart policy survives a process abort.
- Ordered graceful shutdown: stop accepting → drain the pipeline → close pools,
  idempotent across repeated signals, bounded by a hard timeout.

**DoD:** stopping the PostgreSQL container mid-run produces `503`s and a
recovering service, with no application restart and no lost `200`.

---

## Phase 3 — Benchmark rig and baseline · H+2:15 → H+3:30

### T12 · k6 rig · BENCH · 25 min
Per `05-BENCHMARK-PROTOCOL.md` §2. k6 runs from the `grafana/k6` image on the
compose network so the capped containers are the bottleneck, not the harness.
Scenarios: sustained load, stress ramp, spike, breakpoint. The generator mixes
backdated timestamps so the partition path is actually exercised.

**DoD:** `npm run bench:load` produces a JSON summary in `bench/raw/`.

### T13 · Drain harness · BENCH · 20 min
**The most important measurement in the project.** After a scenario, walk
`GET /logs` by cursor to the end under a fixed deadline, recording pages/second,
rows/second, per-page p50/p95/p99, total records reached, and whether the walk
reached the true end. Cross-check the walked unique-id count against a trusted
`COUNT(*)` for the same filters.

**DoD:** `npm run bench:drain` reports pages/s and a pass/fail against the
deadline, and its unique-id count matches the database count exactly.

### T14 · Resource capture · BENCH · 10 min
Sample `docker stats` for both containers during every scenario; capture WAL
growth, table and index sizes, buffer hit ratio, temporary-file bytes, and pool
wait time.

**DoD:** a CSV per run under `bench/raw/`.

### T15 · Baseline run + EXPLAIN capture · BENCH · 20 min
One clean-database run of the full set with defaults. Capture
`EXPLAIN (ANALYZE, BUFFERS)` for: unfiltered page, service-filtered page,
hot-attribute page, aggregate grouped and ungrouped, aggregate with a raw
fallback.

**DoD:** `bench/results/baseline.md` and `docs/explain/*.txt` contain real
output. **This is gate G5 baseline.**

---

## Phase 4 — Read-path optimisation · H+3:30 → H+5:00

Run in order. **One variable per experiment.** After each, re-run gate G1 before
keeping the change. Record every result — including the ones that lose — in
`bench/results/experiments.md`.

### T16 · E1 — Move row-to-JSON construction into PostgreSQL · QUERY · 25 min
Compare: driver objects + `JSON.stringify` / PostgreSQL per-row JSON text +
application concatenation / PostgreSQL whole-array JSON. Measure page p95,
application CPU, PostgreSQL CPU, RSS.

**DoD:** a decision recorded with numbers, and the winner shipped.

### T17 · E2 — Direct response write · QUERY · 10 min
Bypass framework JSON serialisation on the page path: set the content type and
write a prepared buffer.

**DoD:** measured delta recorded; kept only if positive.

### T18 · E3 — Bounded read-ahead · QUERY · 25 min
Speculative next-page execution keyed by the freshly minted cursor, held in a
small capped LRU of pre-serialised bodies. Off by default (`READAHEAD_PAGES=0`)
until measured.

**DoD:** drain pages/s before and after; RSS ceiling confirmed; G1 still green;
a correctness test proves an identical walk with and without it. **First item on
the fallback ladder — drop it if the clock demands.**

### T19 · E4 — Batch shape sweep · CORE · 20 min
Target rows, byte budget, coalescing delay, write concurrency. Optimise for
sustained throughput **with PostgreSQL CPU headroom left for reads**, not for
peak throughput.

**DoD:** a chosen configuration with the sweep table recorded.

### T20 · E5 — Pool layout · CORE · 10 min
Reserved split pools versus a larger shared pool, judged on completed drain and
accepted throughput together.

**DoD:** decision recorded with numbers.

### T21 · E6 — COPY versus UNNEST INSERT · CORE · 15 min
Same batcher, same workload, two repository implementations.

**DoD:** decision recorded; loser removed or left behind a documented flag.

### T22 · E7 — Durability profile A/B · CORE · 10 min
`SYNC_COMMIT=off` versus `on`. Both results labelled by profile. Never present
the fast profile as crash-durable.

**DoD:** both rows in the README performance table.

---

## Phase 5 — Final measured run · H+5:00 → H+5:30

### T23 · Clean final run · BENCH · 25 min
Clean database, clean build, chosen configuration, full scenario set plus drain.
The shipped scripts produce exactly the numbers that go in the README — same
batch size, same derived time ranges. Never hardcode a benchmark time range;
derive `since`/`until` from the data actually present, or the run silently
measures an empty range.

**DoD:** `bench/results/final.md` complete and reproducible. **Gate G5 final.**

---

## Phase 6 — Documentation and release · H+5:30 → H+6:00

### T24 · README · DOCS · 20 min
Every section spec §40 requires; outline in `06-RELEASE-CHECKLIST.md` §4.
Performance figures come from `final.md` only. Limitations are honest and do not
contradict the headline results.

**DoD:** every §40 heading present and filled with real content.

### T25 · Pre-push review and release gate · DOCS + INFRA · 15 min
Run the checklist in `06-RELEASE-CHECKLIST.md` §1 and §3, commit
incrementally with meaningful messages, and push.

**DoD:** gate G7 green; remote updated; a fresh clone of the pushed remote boots
with `docker compose up`.

### T26 · Video outline · DOCS · 5 min
A ~5-minute script covering architecture, data flow, schema and index rationale,
ingestion flow, query flow, cursor pagination, attribute strategy, retention,
bottlenecks, and optimisations (spec §44, §45). Recording is the user's task.

**DoD:** `docs/video-outline.md` exists.

---

## Dependency graph

```text
T01 → T02 → T03 → T04(G0)
                    ├→ T05 ┐
                    ├→ T06 ├→ T09(G1) → T10 → T11(G2)
                    ├→ T07 │                    │
                    └→ T08 ┘                    ▼
                                    T12 → T13 → T14 → T15(G5-base)
                                                        │
                        T16 → T17 → T18 ────────────────┤
                        T19 → T20 → T21 → T22 ──────────┤
                                                        ▼
                                              T23(G5-final) → T24 → T25(G7) → T26
```

## Parallelisation

Safe to run concurrently, because the file ownership map in `03-AGENTS.md` gives
each role disjoint paths:

- Phase 1: T05 (CORE) ∥ T06+T07 (QUERY) ∥ T09 (INFRA)
- Phase 3/4: T12–T14 (BENCH) can be built while Phase 1 finishes
- Phase 4: T16–T18 (QUERY) ∥ T19–T22 (CORE) — but they must **serialise at the
  measurement step**, since two simultaneous benchmark runs on one machine
  invalidate both.
