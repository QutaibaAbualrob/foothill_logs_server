# Linux verification brief

**Branch:** `perf/write-path-and-attribute-index`
**Base:** `main` at `bd876ee` (unchanged — this branch is additive and unmerged)
**Written:** 2026-08-17

Read this before running anything. It assumes no prior context.

---

## 1. Why this document exists

Every measurement backing this branch was taken on Windows under Docker
Desktop with the WSL2 backend (`6.6.87.2-microsoft-standard-WSL2`), with the
load generator running on the host and competing with the containers for CPU.
Containers therefore sat inside a VM, and every host-to-container request
crossed that boundary.

That is enough to make some of the recorded conclusions unsafe. This branch
needs a run on native Linux Docker — where containers share the host kernel and
published ports are ordinary NAT — to separate what is a property of the service
from what is a property of the measuring environment.

**The task is verification, not optimisation.** Do not tune, refactor, or
"improve" anything while running this. If a number disagrees with what is
recorded here, that disagreement *is* the result. Record it and stop.

---

## 2. Context: what this branch changed

Four changes, all aimed at one problem — PostgreSQL was saturating its 1-CPU
container cap while the application idled, capping ingestion far below the
15,000 logs/s requirement.

1. **The write batcher now drains its whole queue per flush.** It previously
   stopped at `BATCH_TARGET_ROWS` (2,000) even with a much deeper backlog
   waiting, so the fixed per-transaction cost — connection checkout, `BEGIN`,
   `SET LOCAL`, rollup upsert, `COMMIT` — was paid once per 2,000 rows instead
   of once per backlog. `BATCH_TARGET_ROWS`, `BATCH_MAX_ROWS` and
   `BATCH_TARGET_BYTES` were removed; `QUEUE_MAX_ROWS` and `QUEUE_MAX_BYTES`
   now bound a single transaction, enforced at admission so backpressure still
   surfaces as `503` + `Retry-After`.

2. **`attributes` gained a `jsonb_path_ops` GIN index** with `fastupdate = off`
   (`src/db/migrations/002_attributes_gin.sql`). Filtering on an arbitrary
   attribute key previously had no index and walked the table in cursor order.
   That cost was paid on a **hit** as much as a miss, because the `limit + 1`
   page probe keeps scanning past the matched row to decide whether a next page
   exists. `buildPredicates` now narrows with a containment disjunction and
   rechecks the exact `->>` equality, which preserves the previous semantics
   exactly.

3. **`wal_compression` was dropped** from the PostgreSQL command line, and the
   `trace_id` hot-attribute index was removed from the shipped compose
   (`HOT_ATTRIBUTE_KEYS=`), since every key is now answerable from the GIN
   index.

4. **Two defects were fixed** that were found while doing the above: a sweep in
   `ensureHotAttributeIndexes` matched `indexname LIKE 'logs_attr_%'` where `_`
   is a single-character wildcard, so it silently dropped the new GIN index on
   every startup; and an attribute filter of `1e-999999` returned `500`, because
   it parses to a finite `0` in JavaScript while PostgreSQL rejects the jsonb
   literal outright.

Full reasoning is in `README.md` under *Indexes* and *Performance →
Reconfiguration results*, and in `docs/conclusion.md` under the addendum.

---

## 3. What the test is for

Three open questions, in priority order. Question 1 is the reason this run
exists.

### Q1 — Is the application container really the bottleneck?

On Windows, at 20,720 logs/s (batch 200): **application ~45.5% of its 0.5-CPU
cap (≈91% utilised), PostgreSQL ~53.5% of its 1-CPU cap.** That reads as
"the application is now the constraint".

That conclusion is suspect. It leans on a measurement of `/metrics` — a route
that does no database work and parses no body — topping out at **907 req/s**,
which is implausibly low for Node serving a small JSON response even at 0.5 CPU.
The likely explanation is the WSL2 network path plus a co-resident client, not
the HTTP layer.

- **If the application's CPU share drops on Linux**, the finding was an artifact,
  PostgreSQL is the real ceiling again, and the "profile the app" follow-up in
  `docs/conclusion.md` should be withdrawn.
- **If it holds**, the application genuinely is the constraint and app-side cost
  is where remaining headroom lives.

Useful context for interpreting it: application-side per-log costs were profiled
directly and are small — `JSON.parse` + validation is 2.96 µs/log, CSV row
building is 0.07 µs/log. At 20,720 logs/s that is roughly 6% of one core, which
does **not** account for 45% of the cap. Something else is consuming it.

### Q2 — Does the batch-size curve flatten?

Measured on Windows, ingestion only:

| Client batch size | Throughput |
| --- | --- |
| 50 | 14,340 logs/s |
| 200 | 20,720 logs/s |
| 500 | 19,451 logs/s |

If per-request overhead was mostly transport, batch 50 should land much closer
to batch 200 on Linux and the whole curve should shift up. If the gap persists,
per-request cost is real and belongs to the service.

### Q3 — What is the honest throughput number?

The figure to reproduce is **~20,720 logs/s at batch 200**, ingestion only,
under the capped stack. Treat anything measured at batch 50 as understated.

---

## 4. What to run

```bash
docker compose up -d --build --wait
npm ci
```

Correctness first. All of these must stay green; a failure here outranks any
performance result.

```bash
npm run typecheck && npm test && npm run smoke && npm run reliability
```

```bash
npm run drill
```

Then the measurements, **at batch 200**:

```bash
DURATION_SECONDS=30 CONCURRENCY=96 BATCH_SIZE=200 npm run bench
```

Sample container CPU concurrently — this is the Q1 measurement and the single
most important number to bring back:

```bash
RUN_NAME=linux-verify-$(date +%Y%m%d) DURATION_SECONDS=35 npm run bench:capture
```

For Q2, repeat `npm run bench` at `BATCH_SIZE=50` and `BATCH_SIZE=500`.

`plan/05-BENCHMARK-PROTOCOL.md` is the authority on methodology; follow its
rules on raw-output retention and unique run names.

---

## 5. What is missing or different on Linux

### 5.1 Container names are hardcoded — read this first

`scripts/failure-drill.sh` (10 call sites) and `scripts/capture-resources.mjs`
hardcode `server_loger-api-1` and `server_loger-postgres-1`. The compose file
sets no project name, so it derives from the **directory name** — which is
`server_loger` on the Windows machine but will be whatever you clone into.

This fails **quietly**, not loudly: the drill's `docker inspect` calls end in
`|| echo unknown` and its `docker kill` ends in `|| true`, so a name mismatch
produces a confident-looking but meaningless result rather than an error.

Pick one before running anything:

```bash
git clone <url> server_loger && cd server_loger
```

or set the project name explicitly for every command:

```bash
export COMPOSE_PROJECT_NAME=server_loger
```

Verify before trusting the drill:

```bash
docker compose ps --format '{{.Name}}'
```

The names printed must match those hardcoded strings. The proper fix is a
top-level `name: server_loger` in `docker-compose.yml`, but that is a change to
the branch under test — if you make it, record it as a deviation.

### 5.2 Integration tests skip silently

`docker-compose.yml` publishes no port for PostgreSQL, so `TEST_DATABASE_URL` is
unset and `test/integration/*` skip with `skipped: TEST_DATABASE_URL unset` —
while still reporting the file as passing. **A green `npm test` does not by
itself mean the integration tests ran.** Confirm you see
`aggregate: aligned range …` and `one retention pass drops …` in the output.

To run them, publish the port with an override:

```yaml
# compose.pg-port.yml
services:
  postgres:
    ports: ["55432:5432"]
```

```bash
docker compose -f docker-compose.yml -f compose.pg-port.yml up -d postgres
TEST_DATABASE_URL=postgresql://logger:logger@localhost:55432/logs npm test
```

Expected: **26 tests, 26 pass**, with the two integration tests among them.

### 5.3 There is no committed mixed-workload harness

`plan/05-BENCHMARK-PROTOCOL.md` now requires read-after-write probing **at
ingestion rate** — a lookup after every accepted `POST`, not on a timer. No
committed script does this. `scripts/benchmark.mjs` is ingestion-only plus a
once-per-second aggregate probe.

The Windows mixed-workload figures (2,431 → 10,062 logs/s; read-after-write
0.4% → 100%; HTTP errors 20% → 0%) came from an ad-hoc harness that was never
committed. **Those numbers cannot be reproduced from this repository as it
stands.**

If reproducing them is in scope, the harness is: N concurrent workers, each
posting a batch whose first entry carries a unique `marker` attribute, then
immediately issuing `GET /logs?attr.<marker>=<value>&limit=1` and recording
whether the row was found. Report throughput, read-after-write success rate,
HTTP error rate, and both latency percentiles. If it is out of scope, say so in
the results rather than substituting an ingestion-only number.

### 5.4 Smaller items

- **k6 is not required.** `load/*.js` run through the `grafana/k6` container
  image per `plan/05-BENCHMARK-PROTOCOL.md`; nothing needs installing.
- **Node 22+** is required (`package.json` engines).
- `scripts/failure-drill.sh` carries workarounds for a Git-bash `curl` that
  cannot write to `/dev/null`. They are harmless on Linux — it writes probe
  bodies to a scratch file instead. No change needed.
- The reliability suite needs rows in the table to mint a pagination cursor. On
  a freshly wiped volume, `mint a cursor` fails. Run a short ingestion first,
  or run `npm run reliability` after `npm run bench`.
- Editing an applied file under `src/db/migrations/` makes startup fail against
  an existing volume (`applied migration <name> was modified`). Reset with
  `docker compose down -v`.

---

## 6. What to bring back

1. `npm run typecheck`, `npm test` (with the integration tests actually
   running), `npm run smoke`, `npm run reliability`, `npm run drill` — pass/fail
   for each, with output for anything that fails.
2. **Q1:** application and PostgreSQL CPU average and max during the batch-200
   ingestion run, plus the achieved logs/s. State plainly whether the
   application is or is not the binding constraint.
3. **Q2:** the three-point batch-size curve (50 / 200 / 500).
4. Host details: kernel, CPU count, whether the load generator ran on the same
   machine as the containers.
5. Anything that contradicts section 2 or 3.

Numbers taken with the load generator on the same host are still confounded,
just less so than under WSL2. Say which arrangement was used — it changes how
much the result is worth.

---

## 7. Out of scope

- Do not merge this branch or push to `main`.
- Do not rewrite public history. `plan/internal/SANITIZATION.md` §3.1 flags
  pre-existing already-pushed commits; that is documented and accepted in
  `docs/conclusion.md`, and clearing it needs an explicit decision from the
  repository owner.
- Do not commit anything from a scratch or working directory.
- Do not "fix" a disappointing number. Record it.
