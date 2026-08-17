# agents.md — start here

You are working on `E:\server_loger` — a log-ingestion service (Express +
PostgreSQL, Docker Compose) built to a published project brief. This file is
the map for humans and AI agents alike.

## Repository map

| Path | What it is |
| --- | --- |
| `src/`, `scripts/`, `test/`, `load/` | The code, benchmark harnesses, correctness gates, load tests. |
| `docker-compose.yml`, `Dockerfile`, `package.json` | What gets run: app 0.5 CPU / 256 MB, database 1 CPU / 1 GB. The app CPU cap is settled at 0.5 — do not raise it. |
| `docs/test_results/` | Measured runs of this code on Linux — the source of truth for performance numbers. |
| `plan/` | The delivery plan: `00-MASTER-PLAN.md` (thesis + schedule), `HANDOFF.md` (state of the build), `05-BENCHMARK-PROTOCOL.md` (how we measure). |
| `plan/internal/SANITIZATION.md` | **Pre-push review. Read it before every commit/push.** Gitignored — never tracked. |
| `search_rnd/RND.md` | The R&D record: research decisions and design rules. |
| `bench/` | Raw benchmark outputs (`raw/` is gitignored) and measured results. |

**Where the deep analysis lives:** the detailed score analysis, cross-repo
comparisons, and all third-party material are kept in a **separate private
repository on this machine** — not in this repo, and never referenced from
anything public. Location and rules: `plan/internal/SANITIZATION.md` §7.

## The next step — do this first, before any code change

Two measurements are missing:

1. The batch curve was measured at batch sizes 50/200/500 but never at 33.
   Run it:

```
cd E:\server_loger
BASE_URL=http://127.0.0.1:8080 DURATION_SECONDS=60 CONCURRENCY=96 BATCH_SIZE=33 RESULT_PATH=bench/raw/batch33.json node scripts/benchmark.mjs
```

(If port 8080 is taken on this machine, bring the stack up with
`HOST_PORT=8081` and use that in `BASE_URL`.)

2. A CPU profile attached to the ingest path (`NODE_OPTIONS=--cpu-prof` on
   the api container, then read the `.cpuprofile`). This settles where the
   per-request cost actually is before anyone changes the HTTP layer.

Record both results in `docs/test_results/` before moving on.

## The path after the measurement (owner decision, 2026-08-17)

- The application CPU cap stays at **0.5**. The raise-it option is rejected.
- Framework work happens **on a branch, never directly on main**:
  1. Try **Fastify on Node** (framework swap only) on a branch.
  2. Then try **Fastify + Bun** (framework + runtime swap) on a branch.
- **Commit to main only if the measurements show it's worth it.** For every
  step, record before/after: batch-33 throughput, ingest p50/p95/p99,
  aggregate p95, and the drain page rate.
- Scope, risks, and the gates that must stay green for the swap: the private
  analysis repo (see `plan/internal/SANITIZATION.md` §7), AGENT-HANDOFF §9.

## Standing rules

- **CHANGES sections in docs are append-only.** Add entries, never rewrite.
- **Every claim must trace to a file on disk.** No number without a source.
- **Gates that must stay green:** 32/32 tests, `npm run smoke`, 73/73
  reliability checks, the failure drill (all endpoints degrade to 503 +
  `Retry-After`, SIGTERM exits 0, acknowledged rows match the database).
- **Native Windows paths for Python** — MSYS `/e/...` paths fail silently.
- **`bench/raw/` is gitignored** — `RESULT_PATH` must be a new file.
- **Sanitization:** before any commit or push, run every check in
  `plan/internal/SANITIZATION.md`. In particular: nothing about third-party
  code, external run data, or the evaluation platform goes into tracked files
  or commit messages. Commits are in the owner's name only.
