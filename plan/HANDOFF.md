# Handoff — state of the build

**Written:** 2026-08-16, end of the first working session.
**Read this with** `00-MASTER-PLAN.md` (schedule and thesis) and `02-TASKS.md`
(task board). This file records only what is *actually true right now*, so that
the next session does not have to re-derive it or re-measure it.

---

## 1. Where the work stands

| Phase | Task | State |
| --- | --- | --- |
| 0 | T01 promote to root | **done** |
| 0 | T02 ignore rules | **done** — `.gitignore`, `.dockerignore`, plus a new `.gitattributes` |
| 0 | T03 PDF history | **deliberately skipped** — see §5 |
| 0 | T04 clean boot (G0) | **done** — see the port caveat in §4 |
| 1 | T05 ingestion contract | **done** |
| 1 | T06 query contract | **done**, plus a real defect fixed — see §3 |
| 1 | T07 aggregate contract | **partially done** — see §2, item 1 |
| 1 | T08 retention and health | code present, **untested** — see §2, item 2 |
| 1 | T09 contract smoke (G1) | **done** — `npm run smoke` |
| 2 | T10 edge cases (G2) | **done** — `npm run reliability`, 72 checks |
| 2 | T11 failure modes | **done** for the database-outage rows — see §2, item 3 |
| 3 | T12–T15 bench rig, baseline | **not started** — but see the measurements in §6 |
| 4 | T16–T22 optimisation | **not started** |
| 5 | T23 final run | **not started** |
| 6 | T24 README | **not started — this is the biggest remaining gap** |
| 6 | T25 submission gate | **not started** |
| 6 | T26 video outline | **not started** |

Two local commits sit on top of `e5cc3c1`. **Nothing has been pushed.**
`origin` is `https://github.com/QutaibaAbualrob/foothill_logs_server.git`.

---

## 2. Start here — the ordered list of what is left

1. **README (`T24`) — highest priority.** It does not exist. The root
   `README.md` still contains the two words it was created with. It is on the
   plan's "never cut" list and it is the single largest gap in the submission.
   The outline is in `06-SUBMISSION-CHECKLIST.md` §4. Real numbers to put in it
   are in §6 below; anything not measured must be labelled as not measured.

2. **Aggregate exact edge slices (`T07`).** `query/repository.ts` currently
   decides `canUseRollup` by requiring `since` and `until` to fall exactly on a
   minute boundary, and falls back to a **full raw scan** otherwise. That is
   *correct* — an unaligned range never counts a whole edge minute, which is
   what G4 asks — but it is not what `01-ARCHITECTURE.md` §6 specifies, and it
   is slow for the common case of a range that is unaligned by a few seconds.
   The specified design is: rollup for the aligned interior, plus two small raw
   queries for the partial edge minutes. Worth doing, and it is a pure
   performance change with an existing correctness gate to protect it.

3. **Retention (`T08`) has never been executed.** The worker code reads
   correctly and is advisory-locked on the maintenance pool, but no test has
   ever run a retention pass. The DoD wants an integration test that seeds an
   expired partition, runs one cycle, and asserts both the raw rows and the
   rollup counts are gone. Note `RETENTION_INTERVAL_MS` defaults to one hour, so
   a test must call the pass directly rather than wait for the timer.

4. **Graceful shutdown under load (`T11`, last row).** `scripts/failure-drill.sh`
   covers the database-outage rows but not SIGTERM. Needs: start ingestion, send
   SIGTERM mid-flight, assert in-flight batches drain and no acknowledged row is
   lost, and that a repeated SIGTERM is idempotent.

5. **Phase 3 onward as written in the plan.** The one thing to carry forward:
   `scripts/drain.mjs` already exists and is the T13 drain harness. It reports
   pages/s, rows/s and per-page p50/p95/p99, and it **fails the run** on
   duplicates, ordering violations, or a unique-row count that does not match
   `EXPECT_TOTAL`. Use it as the correctness gate after every Phase 4 change,
   not just as a benchmark.

6. **G3 needs >1M rows.** The database currently holds ~600k. The full-scale
   pagination gate has not been run at the required volume.

---

## 3. The two real defects found and fixed — do not reintroduce these

**Cursor ordering (fixed in `87d3c16`).** The page query selected
`logs.id::text AS id` and then ordered by an *unqualified* `id`. SQL resolves an
unqualified `ORDER BY` name against the output columns first, so it sorted by
the text alias — lexicographically, where `'9'` sorts after `'12'` — while the
keyset predicate in `builder.ts` compares `id` as `bigint`. The two disagreed,
so rows sharing a timestamp were skipped mid-walk while the response still
reported a clean `next_cursor`. It also cost the plan its pure index scan,
adding an `Incremental Sort` node.

The drain harness measured **18 ordering violations before, 0 after**, across
599,635 rows. Both sort columns are now table-qualified and there is a comment
in `query/repository.ts` saying why. If you touch that query, keep the
qualification.

Note the trap that made this hard to catch: at 600k rows every id is six digits,
and text order equals numeric order when all ids are the same length. It only
diverges when a tied group straddles a digit-length boundary — 9→10, and
999999→1000000, i.e. **exactly at the one million rows the spec requires**. A
small fixture will not reproduce it; the full drain cross-check will.

**Crash on database loss (fixed in `673b2ff`).** Stopping PostgreSQL killed the
process outright. The top-level `await migrate(...)` in `index.ts` ran at import
time, so an unreachable database rejected the bootstrap, the process exited, and
the restart policy returned it to the same failing state — a crash loop that
could only escape if a restart happened to land while the database was up.
Startup database work now retries with bounded backoff, and
`isDatabaseUnavailable()` in `db/pools.ts` classifies connection loss, admin and
crash shutdown, "starting up", saturation and pool timeouts as 503 + `Retry-After`.

---

## 4. Environment gotchas that will waste your time

- **Port 8080 on this machine is taken** by an unrelated Frappe stack
  (`frappe_docker-frontend-1`). Do not stop it — it is the user's. Every command
  in this session used `HOST_PORT=8081`, which `docker-compose.yml` already
  supports:

  ```bash
  HOST_PORT=8081 docker compose up -d --wait
  ```

  Zero-config `docker compose up` on port 8080 is still the shipped default and
  is what a reviewer will run. Verify G0 on a machine where 8080 is free before
  claiming it.

- **The migration is checksummed.** Editing `src/db/migrations/001_init.sql`
  makes startup fail with `applied migration 001_init.sql was modified` against
  an existing volume. Reset with `docker compose down -v`.

- **`CURSOR_SECRET` now defaults to a random value per process start** if unset,
  per `01-ARCHITECTURE.md` §9. Compose sets a fixed one so cursors survive a
  container restart. A cursor minted before a restart without it is rejected —
  that is intended, but it will look like a bug during manual testing.

- **Do not add a `Co-Authored-By` trailer to commits.** The user asked for
  commits in their name only.

---

## 5. The tracked PDFs — a decision was made, do not silently reverse it

`search_rnd/books/` holds ~59 MB of copyrighted PDFs, and they are already in
the pushed history on GitHub. `06-SUBMISSION-CHECKLIST.md` §2 recommends
rewriting history to drop them. **The user was asked and chose to leave them
entirely as-is.** Removing them now would require a force-push over the public
remote, so do not do it without asking again.

`.dockerignore` excludes `search_rnd`, so they do not reach the build context.

---

## 6. Measurements taken so far — real, reproducible, and NOT yet in a results file

All figures below come from the capped compose stack (application 0.5 CPU /
256 MB, PostgreSQL 1 CPU / 1 GB) on the user's Windows machine with the load
generator running on the host. They are honest but **preliminary** — they are
not a Phase 3 baseline, they were not taken from a clean database, and they have
not been written to `bench/results/`. Treat them as a starting point, not as the
README's numbers.

**Ingestion** — `scripts/benchmark.mjs`, 30 s, 64 workers, batch 200:

| Metric | Value |
| --- | --- |
| Accepted | 599,600 logs |
| Throughput | **19,504 logs/s** sustained |
| Errors | 0 |
| Ingest p50 / p95 / p99 | 610 / 901 / 1150 ms (whole batch of 200) |
| Aggregate p95, concurrent | **112 ms** (requirement: < 1 s) |

**Drain walk** — `scripts/drain.mjs`, 1,000-row pages, 599,635 rows:

| Metric | Value |
| --- | --- |
| Pages | 600, reached the true end |
| Unique rows walked | 599,635 — matches `COUNT(*)` exactly |
| Duplicates / ordering violations | 0 / 0 |
| Rate | 69.6 pages/s, 69,596 rows/s |
| Page p50 / p95 / p99 | 11.7 / 26.1 / 79.5 ms |

**The page-latency target is not yet met.** The plan's primary target is
≤8 ms p95 for a 1,000-row page; the measured p95 is 26 ms. That gap is what
Phase 4 exists to close, and the plan's own analysis says where to look first:
PostgreSQL side execution for the same page is only **1.6 ms** (`EXPLAIN
(ANALYZE, BUFFERS)`: `Limit` over `Merge Append` of backward index scans,
34 shared buffer hits, no sort node). So the time is going to row
materialisation, JSON serialisation and the HTTP write in the 0.5-CPU
application — exactly the hypothesis behind experiments E1 and E2 in
`05-BENCHMARK-PROTOCOL.md`. Some of the measured latency is also host→container
network overhead on Windows and should be separated out before optimising.

**Storage** at 599,704 rows: 203 MB total, of which **110 MB is indexes**. Index
overhead is over half the table size — relevant to the Phase 4 index-budget
discussion and worth reporting honestly in the README.

---

## 7. Commands

```bash
# bring the stack up (8081 because 8080 is occupied on this machine)
HOST_PORT=8081 docker compose up -d --build --wait

# gates
npm run typecheck && npm test                      # unit
BASE_URL=http://127.0.0.1:8081 npm run smoke       # G1 contract
BASE_URL=http://127.0.0.1:8081 npm run reliability # G2 matrix, 72 checks
HOST_PORT=8081 npm run drill                       # G2 database-outage rows

# measurement
BASE_URL=http://127.0.0.1:8081 DURATION_SECONDS=30 CONCURRENCY=64 BATCH_SIZE=200 npm run bench
COUNT=$(docker compose exec -T postgres psql -U logger -d logs -tAc "SELECT count(*) FROM logs;" | tr -d '[:space:]')
BASE_URL=http://127.0.0.1:8081 PAGE_SIZE=1000 EXPECT_TOTAL=$COUNT npm run bench:drain
```

---

## 8. Standing rules carried forward from the plan

- One variable per experiment; re-run G1 before keeping any Phase 4 change.
- A target that is missed is written down as missed, with the measured number.
  The 8 ms page target is currently missed at 26 ms — say so until it is not.
- Every README figure must be reproducible by a script in this repository.
- Nothing in the tree should read as though it were written for a grader rather
  than for an engineer. A previous hardcoded `marker` attribute and its
  "score harness" comment have already been generalised into
  `HOT_ATTRIBUTE_KEYS`; keep that standard.
