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

**Where measurement data lives — and what you must do with it.** The harnesses
write to `bench/raw/`, which is gitignored: **nothing you measure survives a
clean checkout unless you move it.** The split is deliberate:

| What | Where | Tracked here? |
| --- | --- | --- |
| Narrative write-ups | `docs/test_results/*.md` | yes |
| Per-run index (`runs.csv`) + its README | `bench/results/<date>-<topic>/` | yes |
| Raw harness output, resource CSVs, CPU profiles | private analysis repo only | **no** — gitignored |

Profiles and raw output stay out of this repo because a `.cpuprofile` contains
the service's full call tree and internal paths, and the volume does not belong
in a public tree. `.gitignore` enforces it (`bench/results/**/raw/`,
`**/profiles/`, `*.cpuprofile*`), so `git add -A` cannot pull them in by
accident.

**Your obligation after any measurement session:** copy the raw output and
profiles into the private analysis repo (location and rules:
`plan/internal/SANITIZATION.md` §7), then **commit and push them there in the
same session**. Do not leave them only in `bench/raw/`. The 2026-08-17 set is
the worked example — `bench/results/2026-08-17-fastify-vs-express/README.md`
here, full evidence in the private repo.

## Status — keep this section true

**When you finish something listed here, update this file in the same session:**
move it to Done with a pointer to the file holding the evidence, and write what
the new next step is. Recording results in `docs/test_results/` is not enough on
its own — an agent that reads only this file must not be sent to re-measure work
that is already finished. If a task turns out to be partly done, say which part.

### Done

- [x] **Batch-33 point on the batch curve** — 2026-08-17. 8,169.8 logs/s, 0
  errors, ingest p50/p95 378/604 ms, api container at 47.9% of its 50% cap while
  postgres kept ~60% of its own in reserve. The whole 33/50/200/500 curve was
  re-measured in one session because the recorded one could not be extended.
  Evidence: `docs/test_results/batch33-and-cpu-profile.md` §1.

- [x] **CPU profile of the ingest path** — 2026-08-17. Answers the open Q1 in
  `plan/07-LINUX-VERIFICATION.md`. GC ~34% of on-CPU time, app code ~37%,
  `body-parser` JSON parse ~8%, Express + router 8.9% at batch 33 but only
  2.4–2.9% at batch 200, `pg` 0.2%. GC is allocation churn (59.7 scavenges/s),
  not heap exhaustion — peak heap 43 MB against a 192 MB cap.
  Evidence: same file, §3 and §4.

  Method note for whoever profiles next: `--cpu-prof` is permitted in
  `NODE_OPTIONS`, `--trace-gc` is **not** (it crash-loops the container — put it
  on the command line instead). Under the 0.5-CPU cap, CFS throttling smears
  stall time onto whatever frame is executing, so always take a raised-cap
  control run before trusting a wall-clock share. Overrides are kept in
  `bench/raw/` so the shipped compose file is never edited.

- [x] **Fastify on Node, on a branch** — 2026-08-17, branch `perf/fastify-node`
  at `68766fe`. Green on every gate (32/32 tests, smoke, 73/73 reliability,
  failure drill) and **~7.7% faster than Express** at batch 200, winning all
  eight paired runs across three independently taken A/B sets. Aggregate p95
  improves too (554 ms against 631 ms). **Not merged — that call is the
  owner's.** Evidence: `docs/test_results/fastify-branch-results.md`.

  The branch declares no response schemas, which is where Fastify's
  serialisation advantage lives, so this is its floor rather than its ceiling.

  **Protocol lessons — both cost real time, both will recur:**
  1. This host drifts tens of percent between sessions. Never compare against a
     baseline measured earlier. Interleave the branches, repeat at least three
     times, clean volume per run, report the spread.
  2. **Verify from inside the container which build is running** — do not trust
     a branch name. A commit intended for this branch landed on `main` while a
     second worktree was in play, which silently inverted an entire A/B and
     produced a confident, exactly backwards conclusion. One line does it:
     `docker compose exec -T api sh -c 'ls node_modules | grep -xE "fastify|express"'`.

### Next

1. **Profile the read/drain path.** Only ingest has been profiled. The worst
   outstanding miss is on the read side — drain page p95 87 ms against an 8 ms
   target — and that path serialises 1,000-row JSON pages, which is where a
   framework swap makes its largest claim. Until this exists, the framework
   question is only half answered.

2. **Decide on merging `perf/fastify-node`** (owner's call — the measurement bar
   is met). If it merges, the drain A/B in item 1 should be taken against the
   merged code, since the framework's effect on the read path is unmeasured.

3. **Allocation reduction remains the largest single ingest target**, and it is
   independent of the framework: `computeRollups` (9.6% of on-CPU) and `csv`
   (5.2%) both build strings and objects per log, feeding the ~34% GC cost.

4. **Optional:** re-test Fastify with response schemas, which this branch does
   not declare. Bun is a separate variable and none of these measurements say
   anything about it.

## The path after the measurement (owner decision, 2026-08-17)

The measurements this section was waiting on now exist — see Status above. The
decision itself is unchanged and stays the owner's; the evidence is an input to
the "is it worth it" gate below, not a substitute for it.

- The application CPU cap stays at **0.5**. The raise-it option is rejected.
  (A 4.0-CPU run exists in `bench/raw/` as a *diagnostic control only*, to
  separate real cost from throttle stall. It is not a proposed configuration.)
- Framework work happens **on a branch, never directly on main**:
  1. Try **Fastify on Node** (framework swap only) on a branch.
  2. Then try **Fastify + Bun** (framework + runtime swap) on a branch.
- **Commit to main only if the measurements show it's worth it.** For every
  step, record before/after: batch-33 throughput, ingest p50/p95/p99,
  aggregate p95, and the drain page rate.
- Scope, risks, and the gates that must stay green for the swap: the private
  analysis repo (see `plan/internal/SANITIZATION.md` §7), AGENT-HANDOFF §9.

## Standing rules

- **Keep this file current.** Finishing a task includes updating the Status
  section above in the same session — done, with a pointer to the evidence, and
  the new next step written out. This file is the map; a stale map sends the
  next agent to redo finished work.
- **CHANGES sections in docs are append-only.** Add entries, never rewrite.
- **Every claim must trace to a file on disk.** No number without a source.
  This cuts both ways: if a results file states a method its own evidence
  contradicts, fix the file and say so. (One was found on 2026-08-17 — see
  `docs/test_results/batch33-and-cpu-profile.md` §2.)
- **Gates that must stay green:** 32/32 tests, `npm run smoke`, 73/73
  reliability checks, the failure drill (all endpoints degrade to 503 +
  `Retry-After`, SIGTERM exits 0, acknowledged rows match the database).
- **Native Windows paths for Python** — MSYS `/e/...` paths fail silently.
- **`bench/raw/` is gitignored** — `RESULT_PATH` must be a new file. Raw output
  and profiles are evidence: push them to the private analysis repo in the same
  session, or they are lost. See "Where measurement data lives" above.
- **Sanitization:** before any commit or push, run every check in
  `plan/internal/SANITIZATION.md`. In particular: nothing about third-party
  code, external run data, or the evaluation platform goes into tracked files
  or commit messages. Commits are in the owner's name only.
