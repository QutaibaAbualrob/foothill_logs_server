# agents.md — start here

You are working on this repository — a log-ingestion service (PostgreSQL, Docker
Compose) built to a published project brief. This file is the map for humans and
AI agents alike.

**What ships is Fastify on Bun 1.3.14** (merged 2026-08-18), and that is what a
bare `docker compose up` gives you. The 2x2 that decided it — Express/Fastify by
Node/Bun — is fully measured; the three losing cells survive as branches
(`perf/fastify-node`, `perf/bun-runtime`, `perf/fastify-bun`) and are the source
of the comparison numbers below. **Any number in this repository dated
2026-08-17 or earlier describes Express on Node**, so check the date and the
Status section before assuming which stack a figure came from. Development and
all current measurement happen on Linux; older results files were produced on
Windows and say so.

## Repository map

| Path | What it is |
| --- | --- |
| `src/`, `scripts/`, `test/`, `load/` | The code, benchmark harnesses, correctness gates, load tests. |
| `docker-compose.yml`, `Dockerfile`, `package.json` | What gets run: app 0.5 CPU / 256 MB, database 1 CPU / 1 GB. The app CPU cap is settled at 0.5 — do not raise it. |
| `docs/test_results/` | Measured runs of this code on Linux — the source of truth for performance numbers. |
| `plan/` | The delivery plan: `00-MASTER-PLAN.md` (thesis + schedule), `HANDOFF.md` (state of the build), `05-BENCHMARK-PROTOCOL.md` (how we measure), `08-DATABASE-COST-REDUCTION.md` (**the work in flight — read this before touching the database**). |
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
  failure drill), **~30.6% faster than Express at batch 33** and **~7.7% faster
  at batch 200**, winning all fourteen paired runs. Aggregate p95 improves too
  (554 ms against 631 ms at batch 200). **Not merged — that call is the
  owner's.** Evidence: `docs/test_results/fastify-branch-results.md`.

  Both points are measured to the standard below. Batches 50 and 500 are not.

  The gain is **~4× larger at batch 33 than at batch 200**, tracking the HTTP
  layer's share of on-CPU time at each point (19.3% vs 7.5%) — the framework's
  benefit follows the framework's cost. The client chooses the batch size, not
  the service, so the small-batch case is not hypothetical.

  The branch declares no response schemas, which is where Fastify's
  serialisation advantage lives, so this is its floor rather than its ceiling.

  **Protocol lessons — both cost real time, both will recur:**
  1. Interleave the branches, repeat at least three times, clean volume per run,
     report the spread. Measured noise is **~6%** for a repeated build within a
     session and **~11%** across sessions — enough to bury a 10% effect in a
     single pair. (An earlier version of this file blamed "tens of percent of
     host drift". That was wrong: it came from comparing two different builds
     under the same label, i.e. trap 2 below. Corrected 2026-08-17 after an
     independent session supplied matching Express baselines.)
  2. **Verify from inside the container which build is running** — do not trust
     a branch name. A commit intended for this branch landed on `main` while a
     second worktree was in play, which silently inverted an entire A/B and
     produced a confident, exactly backwards conclusion. One line does it:
     `docker compose exec -T api sh -c 'ls node_modules | grep -xE "fastify|express"'`.

- [x] **Express on Bun, on a branch** — 2026-08-17, branch `perf/bun-runtime` at
  `a5a00bb`. Runtime swap only: `src/` is byte identical to `main`, so Express 5,
  `pg` and `pg-copy-streams` run unmodified on Bun 1.3.14. Green on every gate
  **on Bun** — 32/32 tests with `TEST_DATABASE_URL` set so the integration files
  execute instead of self-skipping, smoke, 73/73 reliability, and the failure
  drill with SIGTERM exit 0 and 377,800 of 377,800 acknowledged rows persisted.
  Measured to the standard below: 12 runs, batch 200 first and then batch 33,
  three interleaved pairs each, exclusive host, **0 errors throughout**.

  | | Node 22.18 | Bun 1.3.14 | multiple |
  | --- | ---: | ---: | ---: |
  | batch 200 | 14,389 (13,689–14,681) | 28,345 (28,139–31,105) | **1.97×** |
  | batch 33 | 8,217 (8,101–8,709) | 18,648 (18,327–18,697) | **2.27×** |

  Bun clears the 15,000 logs/s target at both batch sizes with aggregate p95 at
  166–284 ms and 77–84 ms respectively; **Node clears it at neither**, missing
  batch 200 by 2–9%. **Not merged — that call is the owner's.** Evidence on that
  branch: `bench/results/2026-08-17-bun-vs-express/` and `docs/bun-branch.md`.

  **The batch-200 Bun cells are database-limited** — the api container idles a
  third of its cap there (33.1–34.6% of 50%) while postgres reaches 84.3–100% of
  its own. 1.97× is therefore a floor, and the compression from 2.27× is at least
  partly the database ceiling arriving rather than the HTTP layer's share
  shrinking. The runtime swap compresses by 1.15× across the two points where the
  framework swap compressed 4×.

  **Two measurement defects were found and fixed on that branch**, both of which
  silently corrupt any run taken beside a second compose project:
  `scripts/failure-drill.sh` and `scripts/capture-resources.mjs` each hardcoded
  container names while every other docker call in them follows
  `COMPOSE_PROJECT_NAME`. The capture one is the dangerous one — it does not
  fail, it reports the other compose project's CPU and RSS as this run's.

- [x] **Fastify + Bun, the fourth cell** — 2026-08-17, branch `perf/fastify-bun`
  at `cc4b75b` (`68766fe` cherry-picked onto `perf/bun-runtime`, with a
  regenerated `bun.lock`). All gates green, including 73/73 reliability and the
  drill. Fastify adds **+9.4% on Bun at batch 33** and **−0.5% — a null — at
  batch 200**, where the cell is database-limited and no HTTP-layer change can
  move it. Evidence on that branch: `docs/test_results/fastify-bun-results.md`
  and `bench/results/2026-08-17-fastify-bun/`.

  **The 2×2 is now complete, and the two changes are not additive.** Fastify is
  worth +30.6% on Node at batch 33 but only +9.4% on Bun: Bun's HTTP layer is
  already fast, so there is less framework overhead left to remove. Batch 33,
  logs/s, application-limited on every cell:

  | | Express | Fastify | framework gain |
  | --- | ---: | ---: | ---: |
  | **Node** | 8,603 | 11,233 | +30.6% |
  | **Bun** | 18,361 | 20,095 | +9.4% |
  | runtime gain | **+113%** | **+79%** | |

  The runtime is the larger effect by an order of magnitude, at both batch sizes.

  The single-copy warning that stood here is **cleared**: `perf/fastify-bun` is
  pushed and in sync with `origin/perf/fastify-bun` as of 2026-08-18, as are the
  other three branches.

- [x] **Cursor drain walk on Fastify + Bun at 1.5M rows** — 2026-08-18, branch
  `perf/fastify-bun` at `592e17a`. The correctness gate that blocked the
  adoption decision. Three walks over a **1,511,600-row** table — unfiltered,
  `service=payments`, and an unfiltered repeat — each returned **0 duplicates, 0
  ordering violations, `reachedEnd: true`, and unique rows equal to `COUNT(*)`**.
  Stack verified in-container: `bun run src/index.ts`, Bun 1.3.14, `fastify` and
  not `express`. Evidence: `docs/test_results/drain-fastify-bun.md` and
  `bench/results/2026-08-18-fastify-bun-drain/` on that branch.

  The dataset actually crosses the boundary the gate exists for: a **400-row
  tied-timestamp group spanning ids 999,801–1,000,200**, five such straddling
  groups in all. A walk that stopped below a million rows would not have tested
  it.

  **New finding — the drain path is application-limited, not database-limited.**
  Over the captured walk the api container is pinned at 46.5% avg / 51.1% max of
  its 50% cap while postgres keeps well over half of its own in reserve, at a
  99.4% buffer hit ratio. The cost of a page is in the application, serialising
  1,000 rows of JSON. That is where a framework swap makes its largest claim, so
  the headroom for the read-path A/B is real — this run does **not** say what
  either swap does with it.

  **Page latency here is a screen, not a comparison.** No Node baseline was taken
  in the session, and the two identical unfiltered walks differ by 26% between
  themselves (35.1 s and 27.9 s, warming cache). Page p50/p95/p99 landed at
  14.6–18.3 / 40.0–49.6 / 76.8–82.8 ms. Do not set these against the 87 ms
  recorded for `main` earlier — different build, different session, different
  table size.

- [x] **The ingest age floor is opt-in, off by default** — 2026-08-18. Added
  2026-08-18 derived from `RETENTION_DAYS`, then made opt-in the same day before
  it could ship. Rejecting a backdated log is more honest than accepting it and
  deleting it on the next retention pass, but it is a **change to the ingest
  contract**: a client backfilling history gets a per-entry rejection where it
  previously got a 200. `MAX_LOG_AGE_DAYS` (default `0` = no floor) now controls
  it, and it is exposed in `docker-compose.yml` so it is actually reachable —
  setting it only in the host shell does nothing, since compose passes through
  just what the `environment:` block declares. Verified end to end both ways.

- [x] **Schema: ingest time recorded, the two free-text fields bounded** —
  2026-08-18, `main` at `58ad64d`, migration
  `003_ingested_at_and_field_bounds.sql`. `ingested_at` is added in **two
  statements**, not the obvious one-liner: `clock_timestamp()` is VOLATILE, and
  PostgreSQL only keeps a default in the catalog when it is non-volatile, so
  `ADD COLUMN ... NOT NULL DEFAULT clock_timestamp()` rewrites **every
  partition** under ACCESS EXCLUSIVE — and `migrate()` runs at startup before
  the service serves traffic, which turns a restart into an outage. Adding the
  column nullable and then setting the default is catalog-only. The length
  constraints are `NOT VALID` for the same reason. `service`/`message` also gain
  matching edge checks in `validateEntry`, and timestamps gain a retention-window
  floor (previously only a future bound existed, so a backdated row landed in the
  DEFAULT partition, which `dropExpiredPartitions` never drops). Verified against
  PostgreSQL 16.4 on a populated partitioned table.

- [x] **The failure drill was vacuous, and is now real** — 2026-08-18, `main` at
  `ec09f9c`. `failure-drill.sh` and `capture-resources.mjs` both hardcoded
  `server_loger-*` container names, which stopped matching when the working
  directory was renamed. The drill was sending SIGTERM to a container that did
  not exist, with the failure swallowed by `|| true`, so the graceful-shutdown
  gate **passed by never running**. Both now resolve through
  `docker compose ps -q` and fail loudly. Treat any drill or resource result
  taken on `main` before this date as unverified. See Standing rules.

- [x] **Mixed-workload harness, and the read-path A/B** — 2026-08-18, `main` at
  `987eab5`. `scripts/mixed-workload.mjs` (`npm run bench:mixed`) is the first
  harness here that reads while writing. It settles the framework/runtime
  question on the read path rather than the write path: Fastify + Bun holds
  **19.6–21.7 drain pages/s and 99.6–99.8% visible** against Express + Node's
  **0.96–1.09 pages/s and 14.5–15.3%**. Full detail and the caveats are in item 0
  of Next, below, and in `docs/test_results/mixed-workload-baseline.md`.

### Next

> **ACTIVE WORK — branch `perf/db-write-cost`, opened 2026-08-18 from `881bd25`.**
>
> The constraint has moved onto PostgreSQL, and the plan for reducing it is
> **`plan/08-DATABASE-COST-REDUCTION.md`**. Read that before starting any
> database work, and before picking up items 1–3 below — several of them are
> now scheduled there rather than free-floating.
>
> **Phase 1 (items 1–5): reduce database CPU per ingested row.** No durability
> trade in any of them. Running **item 1 first and alone** — removing or
> narrowing the two zero-scan indexes — because its result changes the expected
> value of the other four. Phase 1 items: index removal/narrowing, the partial
> attribute index, binary `COPY`, `max_wal_size`, `wal_buffers`.
>
> **Phase 2 (items 6–9): measurement gaps, not tuning.** Explicitly **not
> scheduled** until phase 1 reports: background-writer tuning (direction
> unknown — see the plan), a per-request read-after-write probe, ordering and
> duplicate assertions on the walk *under ingest*, and a closed-loop mode for
> the harness.
>
> **Two standing rules for this work.** One variable per run. And any index
> change reports its **read cost as well as its write gain** — a write gain
> alone is not a decision, because this workload never filters by service or by
> attribute and so cannot see what those indexes are for.
>
> Book-sourced candidates for the same problem, with citations and their own
> ranking, are in `search_rnd/BOOK-OPTIMIZATION-REVIEW.md` (§6 write path, §7
> read/consistency). It was derived independently and agrees on the two leading
> items.

> **0. The read path collapses under concurrent ingest — and Fastify + Bun is
> the fix. Measured 2026-08-18.**
>
> `scripts/mixed-workload.mjs` (`npm run bench:mixed`) measures reads while
> writes are running, which nothing here did before. Three interleaved pairs,
> clean volume per run, build verified in-container, 15,000 logs/s target at
> batch 33:
>
> | | Express + Node | Fastify + Bun |
> | --- | ---: | ---: |
> | drain under load | 0.96–1.09 pages/s | **19.6–21.7** |
> | page p95 | 802–897 ms | 86–90 ms |
> | aggregate p95 | 617–2,318 ms | 86–217 ms |
> | visible in 30 s | 14.5–15.3% | **99.6–99.8%** |
> | limited by | window (out of clock) | **data (walked everything)** |
> | ingest | 8,030–8,896 logs/s | 14,919–14,989 |
> | api / postgres CPU | 46% pinned / 28–33% | 45% / **72–76%, peaks >100%** |
>
> Evidence: `docs/test_results/mixed-workload-baseline.md`.
>
> **Three things follow, and they change earlier conclusions in this file.**
>
> 1. **Every other read number here was taken against a static table** — the
>    2×2's drain figures, the page-latency targets, the 2026-08-18 walk — and so
>    describes a condition the service never operates in. The drain *correctness*
>    gate stands; the page *rate* beside it does not transfer.
> 2. **The throughput-versus-freshness tension does not survive contact with the
>    measurement.** The worry was that accepting more rows leaves a reader
>    further behind. Fastify + Bun accepts ~1.75× more and still makes 99.7%
>    visible against Express's 14.8%: the two were only in tension because the
>    reader was losing a CPU fight it now wins.
> 3. **The constraint has moved to PostgreSQL** (72–76%, peaks over its 1.0 cap,
>    against 28–33% before). Application-side tuning now has far less headroom,
>    and the write-path index question should be re-judged in this harness rather
>    than in isolation.
>
> The gain is ~19×, not the ~2× a per-request cost model predicts, because the
> Express baseline was **starved** rather than slow — its 5 s series shows the
> reader completing zero pages for ~15 consecutive seconds. Freeing app CPU ended
> the starvation; it is a regime change, not a speed-up. Do not extrapolate
> either direction from idle-table numbers.
>
> Two properties of the harness are load-bearing and a replacement must keep
> them: ingest is **open-loop** (dispatched on a clock, not on completions — a
> closed-loop client throttles itself when the server slows, so no backlog forms
> and the effect is invisible), and visibility is measured **while writes
> continue** (against a quiesced server the Express build reports 100% visible
> instead of ~15%). The visibility ratio is a bounded cohort: the walk is
> `since`+`until`-bounded and the denominator covers the same half-open window,
> after an earlier version reported an impossible 100.1%.

**Fastify + Bun is merged and is what ships** — 2026-08-18. A bare
`docker compose up` builds the Bun image and runs `bun run src/index.ts`; the
`Dockerfile.bun` / `docker-compose.bun.yml` overlay pair is gone, folded into the
base files. CI installs both runtimes and runs `npm run typecheck` (load-bearing
now — the image has no build step, so this is the only thing between a type error
and production), the suite on tsx, the suite on `bun test`, then builds and smokes
the Bun image. Gates on the merged tree: typecheck clean, **34/34 on tsx with
integration executing**, **66 pass / 0 fail on Bun's runner**, smoke, 73/73
reliability, drill PASS, and G0 verified with no environment variables set.

Note for anyone running the integration tests: compose does **not** publish
postgres, and there is commonly an unrelated postgres on the host's 5432. Point
`TEST_DATABASE_URL` at `postgres:5432` from inside the compose network, or the
tests fail with `password authentication failed` against a foreign database and
look like real breakage. Without `TEST_DATABASE_URL` they self-skip, which is why
a green `npm test` alone does not mean the integration files ran.

**Two adoption checks are already clear — do not spend a session repeating
them.**

*The drain walk*, 2026-08-18: run at 1,511,600 rows on `perf/fastify-bun`, all
four conditions met, across a tied-timestamp group that straddles the
999,999→1,000,000 boundary. See Status above. What is still unrun on that path:
**attribute-filtered walks** (`HOT_ATTRIBUTE_KEYS` is empty in the shipped
compose file, so the ordered partial-index path was never exercised) and **any
walk under concurrent ingest** — every walk so far ran against a static table.

*Peak RSS*: on Bun + Fastify ingest it is **91.3–105.8 MiB against the 256 MiB
limit** across six 60 s runs (`bench/raw/fb-b*-fastify-run*-resources.csv`), with
Bun + Express at 100–100.9 MiB — roughly 2× Node's 51.9 MiB and comfortably
inside the cap. **The drain path is higher: 147.2 MiB**, 57% of cap
(`bench/raw/2026-08-18-drain-fb-run2-resources.csv`), so it, not ingest, is the
path to watch. Bun's JavaScriptCore heap takes no `--max-old-space-size`
equivalent, so `mem_limit` is the only ceiling: watch peak RSS in runs you are
already taking. **No run longer than 60 s exists on any branch**, so sustained
RSS under a soak is still open.

1. **Drain page latency — the A/B has now been run, under load. What remains is
   the idle comparison and the target itself.** Item 0 settles the version that
   matters: under concurrent ingest, page p95 is 86–90 ms on Fastify + Bun
   against 802–897 ms on Express + Node, interleaved three per side. Do **not**
   re-run that as new work.

   Two things are still genuinely open here:

   - **The idle-table A/B was never run interleaved.** The recorded idle figures
     — 40–50 ms on Fastify + Bun (2026-08-18), 87 ms on `main` in an earlier
     session — remain **not comparable**: different builds, different sessions,
     different table sizes. It is now low value, because the idle condition is
     not the one the service operates in, but do not quote those two numbers
     against each other in the meantime.
   - **The 8 ms target is unmet in every condition measured**, idle or loaded,
     on either stack. Nothing so far has attacked it directly; the gains to date
     came from removing CPU starvation, not from making a page cheaper to
     serialise.

   The earlier claim in this slot that the path is *application-limited* held for
   Express. It no longer describes Fastify + Bun, where the api sits at 45% of
   its cap and **postgres carries 72–76% with peaks over its own** — so further
   page-latency work belongs in the database, or in the response shape, not in
   the HTTP layer. Response schemas (item 6) are the one untried application-side
   lever.

2. **PostgreSQL is profiled — and 173 MB of index is maintained for zero scans.**
   Done 2026-08-18, `docs/test_results/postgres-profile.md`. Database time splits
   **71% writes / 28% reads**: `COPY` is 71.3% at 34.7 ms per batch, the cursor
   page query 28.2% at 7.4–8.9 ms per 1,000 rows, and the rollup `INSERT` just
   0.2% — the `logs_agg_1m` design pays for itself. PostgreSQL is **on CPU, not
   blocked on IO** (186 samples running against 3 on `DataFileRead`, 96.2% buffer
   hit ratio), so the lever is less work, not faster storage.

   The open item this creates: `logs_service_level_page_idx` (**116 MB**) and the
   attribute GIN (**57 MB**) both took **zero scans**, while `EXPLAIN` shows the
   page query served entirely by backward scans on each partition's primary key.
   Both are still maintained inside the `COPY` that owns 71% of database time.
   **This does not make them useless** — this workload never filters by service
   or attribute, and migration 002 records the GIN taking an attribute lookup
   from ~158 ms to ~0.4 ms. It makes them an explicit trade to measure: run the
   drop against `DRAIN_FILTERS=service=checkout` so the read cost is exercised,
   not just the write gain.

   **Both halves of this are now scheduled as phase 1 item 1 in
   `plan/08-DATABASE-COST-REDUCTION.md`** — do not start it from this entry
   alone, and do not report a write gain without the filtered-walk read cost
   beside it.

   Second untouched signal: `buffers_backend` 38,055 against the checkpointer's
   919 and the bgwriter's 18,238 — writers are stalling to find clean buffers.
   `bgwriter_lru_maxpages` and `bgwriter_delay` are at defaults and have never
   been measured. WAL runs ~9.5 MB/s (859 MB per 90 s run) with
   `synchronous_commit=off` already set.

3. **The read path has never been CPU-profiled.** Only ingest has. It now has
   resource numbers but no profile, so which frames own its cost is unknown.
   Take it on the stack that ships — and note Bun's profiler is not V8's, so the
   `.cpuprofile` tooling used for the ingest profile does not transfer directly.

4. **Allocation reduction is an ingest target, but no longer clearly the largest
   one.** `computeRollups` (9.6% of on-CPU) and `csv` (5.2%) do build strings and
   objects per log, feeding the ~34% GC cost — **but every one of those figures
   comes from the V8 profile of Express on Node**, and describes a stack that may
   not ship. Bun's collector is JavaScriptCore's and the profile does not carry
   over. Re-measure before treating these numbers as current.

5. **Optional:** re-test Fastify with response schemas, which neither Fastify
   branch declares — that is where its serialisation advantage lives, so both
   Fastify numbers are floors rather than ceilings. This is now the one untried
   application-side lever on page latency.

6. **Coverage gaps that no run has touched:** batches 50 and 500 on every branch;
   any run longer than 60 s, so no soak and no sustained-RSS figure;
   attribute-filtered walks, since `HOT_ATTRIBUTE_KEYS` is empty in the shipped
   compose file and the ordered partial-index path has therefore never been
   exercised.

## The path after the measurement (owner decision, 2026-08-17)

The measurements this section was waiting on now exist — see Status above. The
decision itself is unchanged and stays the owner's; the evidence is an input to
the "is it worth it" gate below, not a substitute for it.

- The application CPU cap stays at **0.5**. The raise-it option is rejected.
  (A 4.0-CPU run exists in `bench/raw/` as a *diagnostic control only*, to
  separate real cost from throttle stall. It is not a proposed configuration.)
- Framework work happens **on a branch, never directly on main**:
  1. Try **Fastify on Node** (framework swap only) on a branch. — **done**,
     `perf/fastify-node`.
  2. Then try **Fastify + Bun** (framework + runtime swap) on a branch. —
     **done**, `perf/fastify-bun`, built on `perf/bun-runtime`, which isolates
     the runtime on its own so the two variables can be read apart. All three
     branches are measured; see Status above.
- **Commit to main only if the measurements show it's worth it**, and only on
  evidence meeting "The measurement standard" below. For every step record
  before/after: throughput at batch 200 **and** batch 33, ingest p50/p95/p99,
  aggregate p95, and the drain page rate. Batch 33 alone is not sufficient — it
  is the most flattering point for an HTTP-layer change.
- Scope, risks, and the gates that must stay green for the swap: the private
  analysis repo (see `plan/internal/SANITIZATION.md` §7), AGENT-HANDOFF §9.

## The measurement standard — what counts as evidence here

Any A/B that informs a merge, a revert, or a claim in a results file must meet
**all seven** of these. A run that misses one is a screen, not evidence: label it
as such and do not put its number in a headline.

1. **Interleaved.** Alternate the two builds — A, B, A, B, A, B. Never all of A
   then all of B; ordering effects and table growth are large enough to invent a
   result on their own.
2. **Three repeats per side, minimum.** Two cannot separate a 10% effect from
   6% noise.
3. **Clean volume per run.** `docker compose down -v` before every run, and
   record the row count before each one. A warm or growing database is a
   different experiment.
4. **Build verified from inside the container, every run**, and the proof
   recorded beside the result:

   ```
   docker compose exec -T api sh -c 'cat /proc/1/cmdline | tr "\0" " "; echo'
   docker compose exec -T api sh -c 'ls node_modules | grep -xE "fastify|express"'
   ```

   A branch name is not proof. A commit that landed on the wrong branch inverted
   an entire A/B on 2026-08-17 and produced a confident, backwards conclusion.
5. **One variable.** Runtime or framework or index — not two at once. If the
   change necessarily moves two things, say so explicitly in the write-up.
6. **One stack up at a time**, verified before starting. Two compose projects
   running at once contaminate both the host and `capture-resources.mjs`.
7. **Report the spread, not just the mean**, per cell, plus errors, rows before
   and after, and both containers' CPU average and maximum. A cell with non-zero
   errors is not a throughput number.

**Measured noise, for calibration:** ~6% for a repeated build within a session,
~11% across sessions. Never compare against a number from an earlier session.

**Measure at the operating point the decision depends on.** Batch 33 is the most
flattering point for any HTTP-layer change — the framework/runtime share of
on-CPU time is 19.3% there against 7.5% at batch 200 — and batch 200 is where
the 15,000 logs/s target actually lives. A result at one batch size does not
generalise across the curve; say which point you measured and do not imply the
rest.

**Also check the database is not the real ceiling.** If PostgreSQL is at or near
its cap in a cell, that cell is database-limited, not application-limited. Mark
it. Two builds converging there is a real finding, not a failed run.

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
- **Harness scripts must resolve containers from the compose project, never by
  a hardcoded name.** `failure-drill.sh` and `capture-resources.mjs` both
  hardcoded `server_loger-*`, which stopped matching when the working directory
  was renamed. The drill then sent SIGTERM to a container that did not exist and
  reported `unknown` — the shutdown gate was **vacuous, not passing**, and the
  capture script recorded the wrong project's CPU. Both now use
  `docker compose ps -q <service>` and fail loudly when it resolves to nothing
  (fixed on `main` 2026-08-18). Treat any resource or drill result taken on
  `main` before that date as unverified.
- **Gates that must stay green:** 34/34 tests on tsx with `TEST_DATABASE_URL`
  set (66 pass on Bun's own runner), `npm run typecheck`, `npm run smoke`, 73/73
  reliability checks, the failure drill (all endpoints degrade to 503 +
  `Retry-After`, SIGTERM exits 0, acknowledged rows match the database).
  `typecheck` is load-bearing since the Bun image has no build step.
- **`bench/raw/` is gitignored** — `RESULT_PATH` must be a new file. Raw output
  and profiles are evidence: push them to the private analysis repo in the same
  session, or they are lost. See "Where measurement data lives" above.
- **Sanitization:** before any commit or push, run every check in
  `plan/internal/SANITIZATION.md`. In particular: nothing about third-party
  code, external run data, or the evaluation platform goes into tracked files
  or commit messages. Commits are in the owner's name only.
