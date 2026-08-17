# Branch `perf/bun-runtime` — the runtime half of the swap

**Base:** `main` at `1bfb036` ("file restructure")
**Date:** 2026-08-17
**Scope:** one variable — the JavaScript runtime. Node 22.18 → Bun 1.3.14.

This is step 2's *runtime* half of the experiment in `agents.md` §"The path
after the measurement", built as its own branch so it can be merged with the
framework half (`perf/fastify-node`) to produce the Fastify + Bun combination.
Neither branch is a commitment to main; both exist to be measured.

---

## 1. What changed, and what deliberately did not

| File | Change |
| --- | --- |
| `Dockerfile.bun` | New. `oven/bun:1.3.14-slim`, runs `src/index.ts` directly. |
| `docker-compose.bun.yml` | New. Overlay on the shipped compose file — runtime, healthcheck probe, and `NODE_OPTIONS` only. |
| `bun.lock` | New. Migrated from `package-lock.json`, so the dependency tree is the one the Node image installs. |
| `package.json` | `start:bun`, `dev:bun`, `engines.bun`. No dependency changed. |
| `scripts/failure-drill.sh` | Bug fix, see §4. Not runtime-related. |

**Nothing under `src/` was touched.** `git diff main --stat -- src/` is empty.
Express 5, `pg`, `pg-copy-streams`, the batcher, the COPY write path and the
cursor query all run unmodified on Bun. That is the point: any measured
difference belongs to the runtime, not to a rewrite.

Two consequences worth stating plainly rather than discovering later:

- **There is no compile step in the Bun image.** Bun executes TypeScript, so the
  image runs `src/index.ts` instead of `dist/src/index.js`. Type checking was
  not dropped — it lives in `npm run typecheck`, which still runs on Node
  against the same `tsconfig.json`, and it is green on this branch.
- **`--max-old-space-size=192` is cleared, not translated.** It is a V8 flag;
  Bun's heap is JavaScriptCore's and has no equivalent hard cap. The container
  `mem_limit` of 256 MB is unchanged and is the real ceiling, so peak RSS is the
  number to watch. If Bun is ever OOM-killed there, `bun --smol run src/index.ts`
  is the next thing to try — measured and reported as its own run, because it is
  a second variable.

## 2. How to run it

The overlay is applied *on top of* the shipped compose file, never instead of
it, so postgres and every application setting except the runtime are provably
identical to the Node stack. Use a separate project name and host port:

```bash
export COMPOSE_FILE=docker-compose.yml:docker-compose.bun.yml
export COMPOSE_PROJECT_NAME=logs-bun
export HOST_PORT=8090
docker compose up -d --build --wait
```

Gates, against the same stack:

```bash
BASE_URL=http://127.0.0.1:8090 npm run smoke
BASE_URL=http://127.0.0.1:8090 npm run reliability
npm run drill    # inherits COMPOSE_FILE/COMPOSE_PROJECT_NAME/HOST_PORT from the exports above
```

## 3. Gate results on Bun — all green

Taken on this branch, 2026-08-17, against `logs-bun` on port 8090.

| Gate | Result |
| --- | --- |
| `npm run typecheck` | clean (Node/tsc, unchanged tsconfig) |
| `npm test` (on Node — see §3.1 for the Bun runner) | **32/32** |
| `npm run smoke` (G1 contract) | pass — `{"status":"ok","accepted":5,"paginated":5,"aggregateCount":5}` |
| `npm run reliability` (G2) | **73/73**, 0 failures |
| `npm run drill` | **PASS**, every row |

Drill detail, since it is the gate that exercises the runtime hardest:

- all four endpoints degraded to 503 with `Retry-After` while postgres was down,
  none returned a 500, and the container did not restart (`RestartCount` 0,
  `StartedAt` unchanged across the outage and the recovery);
- repeated SIGTERM mid-ingestion exited **0**, the shutdown event was logged, and
  **every acknowledged row persisted** — 410,800 accepted, database count +410,800.

The startup path also works unchanged: migrations applied from `src/db/migrations`
(read relative to cwd, which the image preserves), partitions created, the
retention pass ran, and the service logged `{"event":"ready"}`.

**Stability observation, not a benchmark:** that SIGTERM section pushed 410,800
rows through the Bun container in ~15 s at 32 workers × batch 200 with no OOM
kill and no restart. `docker stats` shortly after the run — not during it —
read 71 MiB RSS against the 256 MB cap; no peak figure was captured, so treat
that as a floor rather than a headroom claim. It says the runtime is stable
under real ingest load at the shipped caps. It says nothing about throughput —
the machine was not exclusive (see §5).

### 3.1 The suite on Bun's own runner, integration tests included

The `npm test` row above runs the suite on **Node** (`tsx --test`) — it proves
the source is unchanged, not that the tests pass under Bun. Run on Bun's own
runner instead, `bun test` executes the `node:test` files unmodified:

| Runner | Result |
| --- | --- |
| `bun test` (Bun 1.3.14) | **32 pass, 0 fail**, 6 files |
| `tsx --test` (Node 22.18) | **32 pass, 0 fail** |

Diffed by test name, the two runners ran the identical set — no test is
silently skipped on either side. Worth knowing what the number contains: 30 are
unit cases and 2 are the integration files, which Node's runner counts as one
passing test each even when they skip themselves for want of a database.

These runs did **not** skip them. Both integration files were given a real
database, so the retention pass and the aggregate edge-slice paths executed for
real on both runtimes and passed. `plan/HANDOFF.md` §2 item 3 records the
retention test as never having been executed; it has now run, on Bun and on
Node, against PostgreSQL 16.4.

```bash
export COMPOSE_FILE=docker-compose.yml:docker-compose.bun.yml
export COMPOSE_PROJECT_NAME=logs-bun
docker compose up -d postgres --wait
docker compose exec -T postgres psql -U logger -d logs -c "CREATE DATABASE logs_test;"

# a scratch database, and the compose network, so the driver reaches postgres
# by service name exactly as the application does
docker run --rm --network logs-bun_default -v "$PWD":/app -w /app \
  -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -e TEST_DATABASE_URL=postgresql://logger:logger@postgres:5432/logs_test \
  oven/bun:1.3.14-slim bun test
```

The tests are mounted from the checkout rather than baked into an image:
`.dockerignore` excludes `test/`, and it should stay excluded — the runtime
image has no business carrying them.

### 3.2 Error mapping, checked by hand — and a gap in the gates

The malformed-JSON and oversized-body branches in `app.ts` read `error.type`
off `body-parser`'s error objects, which is the kind of thing a runtime swap
breaks quietly: the status turns into a 500 and only a client notices. `npm run
smoke` covers malformed JSON, but **no gate in the repository covers the 413
path** — `reliability-check.mjs` never sends an oversized body. Checked directly
against the Bun stack:

| Probe | Result on Bun |
| --- | --- |
| `POST /logs`, ~6 MB body against the 4 MB limit | **413** `{"error":"request body is too large"}` |
| `POST /logs`, body `{bad-json` | **400** `{"error":"malformed JSON"}` |
| `POST /logs`, `content-type: text/plain` | **400** `{"error":"request body must be an object containing a logs array"}` |
| `GET /nope` | **404** `{"error":"not found"}` |

The missing 413 case is a pre-existing coverage gap on `main`, not something
this branch introduced; it is worth adding to `reliability-check.mjs` on main
rather than on either experiment branch.

The compose healthcheck was verified to *fail* as well as pass, since a probe
that can only succeed makes `--wait` meaningless: under Bun it exits 1 on
connection-refused, exits 1 on a 503 response, and exits 0 on 200.

## 4. A defect found on the way — `scripts/failure-drill.sh`

The drill hardcoded the container name `server_loger-api-1` in thirteen places
while its HTTP probes followed `BASE_URL`. Under a second compose project — which
is exactly how a runtime or framework branch gets brought up beside the shipped
stack — the two halves point at different stacks, and it fails silently in the
worst direction: it reports restart-count and SIGTERM results for a container it
never exercised, and it sends a real `SIGTERM` to a stack nobody asked it to
touch. The first drill run on this branch did precisely that.

The container is now resolved from the compose project actually being driven
(`docker compose ps -q api`), with a hard failure if there is none. The fix is
runtime-agnostic and the Fastify branch needs it just as much — see §6.

## 5. What is NOT measured here, and why

**No performance numbers.** `05-BENCHMARK-PROTOCOL.md` §1 rule 7 — one benchmark
at a time on one machine — and the machine was not exclusive: a second compose
stack running the Node build was under active load throughout this session, its
postgres at ~58% CPU. Any batch-33 number taken against that
background would be contention noise attributed to a runtime.

The comparison to run, on an idle machine, against the recorded Node baseline in
`docs/test_results/batch33-and-cpu-profile.md` §1 — 8,169.8 logs/s, 0 errors,
ingest p50/p95/p99 378/604/707 ms, aggregate p95 203.5 ms, api CPU 47.9% of its
50% cap:

```bash
export COMPOSE_FILE=docker-compose.yml:docker-compose.bun.yml
export COMPOSE_PROJECT_NAME=logs-bun HOST_PORT=8090
docker compose down -v && docker compose up -d --build --wait

RUN_NAME=bun-batch33 DURATION_SECONDS=65 npm run bench:capture &
CAPTURE_PID=$!
BASE_URL=http://127.0.0.1:8090 DURATION_SECONDS=60 CONCURRENCY=96 BATCH_SIZE=33 \
  RESULT_PATH=bench/raw/bun-batch33.json npm run bench
wait "$CAPTURE_PID"

COUNT=$(docker compose exec -T postgres psql -U logger -d logs -tAc "SELECT count(*) FROM logs;" | tr -d '[:space:]')
BASE_URL=http://127.0.0.1:8090 PAGE_SIZE=1000 EXPECT_TOTAL=$COUNT DEADLINE_SECONDS=30 \
  RESULT_PATH=bench/raw/bun-drain.json npm run bench:drain
```

Record before/after for the four figures `agents.md` names: batch-33 throughput,
ingest p50/p95/p99, aggregate p95, and the drain page rate. The clean volume
matters — the Node baseline was taken from `down -v`, so a warm database here
would not be comparable.

The read/drain profile that `agents.md` §Next item 1 asks for is still not done,
on either runtime. This branch does not close it.

## 6. Merge notes for combining with `perf/fastify-node`

Built to keep the merge boring:

- **`src/` is untouched here**, so the Fastify branch's rewrite of `app.ts` and
  `index.ts` merges with no conflict from this side. After the merge,
  `docker compose -f docker-compose.yml -f docker-compose.bun.yml` runs the
  Fastify app on Bun — the combination step — with no further edit.
- **`Dockerfile.bun`, `docker-compose.bun.yml`, `bun.lock`, this file**: new
  paths, no conflict.
- **`package.json`**: expect a conflict if the Fastify branch changes
  dependencies. Both sides are additive — keep the Fastify dependency changes
  *and* the three `bun` entries added here. Then regenerate `bun.lock` so it
  carries fastify — otherwise `--frozen-lockfile` fails the image build, which
  is the loud failure this is meant to have. Regenerate in a scratch directory
  rather than in the checkout, so that bun does not overwrite the npm-installed
  `node_modules` the Node-side gates use:

  ```bash
  d=$(mktemp -d) && cp package.json package-lock.json bun.lock "$d"/
  docker run --rm -v "$d":/w -w /w -u "$(id -u):$(id -g)" -e HOME=/tmp \
    oven/bun:1.3.14-slim bun install --ignore-scripts
  cp "$d"/bun.lock bun.lock
  ```
- **`scripts/failure-drill.sh`**: the one file likely to conflict for real, since
  the Fastify branch needs the same fix. The two versions should be the same
  change; take either side, then confirm no `server_loger-api-1` remains.
- **`agents.md` is deliberately not edited on this branch**, so that two
  branches do not both rewrite the same Status section. Text to add to
  §Status → Done once this is merged and measured:

  > - [x] **Bun runtime branch (`perf/bun-runtime`)** — 2026-08-17. Runtime swap
  >   only, `src/` unchanged; boots on Bun 1.3.14 with Express 5, `pg` and
  >   `pg-copy-streams` unmodified. Gates green: 32/32 tests, smoke, 73/73
  >   reliability, failure drill PASS (SIGTERM exit 0, 410,800/410,800
  >   acknowledged rows persisted). Performance not yet measured — the machine
  >   was not exclusive. Evidence: `docs/bun-branch.md`.

## CHANGES

- 2026-08-17 — created with the branch. Gate results in §3, drill defect in §4,
  the unmeasured comparison in §5.
- 2026-08-17 — review pass over this branch. Added §3.1: the error-mapping
  probes, the healthcheck's failure path, and the 413 coverage gap on main.
  Corrected two figures in this file that its own evidence did not support —
  the hardcoded-name count in §4 (thirteen, not eleven) and the RSS reading in
  §3, which was taken after the load rather than during it. Corrected the
  `bun.lock` regeneration command in §6, which as written would have overwritten
  the checkout's npm `node_modules`.
- 2026-08-17 — ran the suite on Bun's own runner (§3.1): 32 pass / 0 fail,
  name-for-name identical to the Node run. Both integration files executed
  against a real database on both runtimes rather than skipping, which is the
  first recorded execution of the retention test.
