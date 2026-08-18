# Reducing database cost per ingested row

**Branch:** `perf/db-write-cost`
**Base:** `main` at `881bd25`
**Written:** 2026-08-18
**Status:** phase 1 in progress — item 1 first, then re-plan

Read this before running anything. It assumes no prior context beyond
`agents.md`.

---

## 1. Why this document exists

Until 2026-08-18 the application was the constraint in this service, and every
optimisation effort went there: the framework swap, the runtime swap, the
allocation work. Adopting Fastify on Bun ended that era. The measured position
now (`docs/test_results/mixed-workload-baseline.md`) is that the api container
sits at **~45% of its 0.5-CPU cap while PostgreSQL carries 72–76% of its own
1.0 cap with peaks above it**.

The first profile of the database (`docs/test_results/postgres-profile.md`)
apportioned that cost:

| Component | Share of database time |
| --- | ---: |
| `COPY logs (...) FROM STDIN` | **71.3%** (34.67 ms per batch) |
| Cursor page query | 28.2% (7.4–8.9 ms per 1,000 rows) |
| Rollup upsert into `logs_agg_1m` | 0.2% (0.10 ms per batch) |

and established that PostgreSQL is **on CPU, not blocked on storage** — 186
running samples against 3 on `DataFileRead`, at a 96.2% heap buffer hit ratio.

**Therefore the ranking question for every item below is the same: how much
PostgreSQL CPU per ingested row does it remove?** Work that targets the
application is aiming at the resource with slack. Work that spends database
write cost to buy read speed is net-negative until a workload proves the read
demand exists.

A second, independent line of evidence points the same way. WAL runs at ~9.5
MB/s — **859 MB across a 90 s run, 1,349,964 rows, so ~636 bytes of WAL per
row**, several times a log row's own width. That excess is index maintenance
and full-page images, which is the same target from a different direction.

### Relationship to the book review

`search_rnd/BOOK-OPTIMIZATION-REVIEW.md` was revised the same day to rank the
book-sourced candidates by this metric. Its §6 (write path) and §7
(read/consistency) were derived independently of this plan and agree with it on
both leading items. Where the two differ, that file carries the book citation
and this file carries the execution order. Two of its findings changed this
plan and are credited inline below (items 5 and 6).

---

## 2. Phase 1 — reduce database CPU per row

Five items, no durability trade in any of them. **Item 1 runs first and alone**;
the remaining four are planned but not scheduled until item 1 reports, because
its result changes their expected value.

### 1. Remove or narrow the zero-scan indexes — first

The profile's headline finding:

| Index | Size | Scans in the profiled run |
| --- | ---: | ---: |
| `logs_2026_08_service_level_timestamp_id_idx` | **116 MB** | **0** |
| `logs_2026_08_attributes_idx` (GIN) | **57 MB** | **0** |
| `logs_2026_08_pkey` | 40 MB | 5,095 |

`EXPLAIN (ANALYZE, BUFFERS)` shows the page query served entirely by a
`Merge Append` of backward primary-key scans. **173 MB of index is maintained
on every inserted row, inside the statement that owns 71.3% of database time,
for zero scans** — and each index also contributes to the 636 bytes/row of WAL.

**State the limit honestly.** This workload's reads are an *unfiltered* cursor
walk plus aggregates. It never filters by `service`, by `level`, or by an
attribute. These indexes are therefore **pure write cost under this query mix —
not proven useless.** Migration `002`'s own comment records the attribute GIN
taking a lookup from ~158 ms to ~0.4 ms. This is a trade to price, not a
cleanup.

**Both halves must be measured. A write gain alone is not a decision.**

- Write half: mixed-workload runs at batch 33 **and** batch 200.
- Read half: a **service-filtered** walk (`DRAIN_FILTERS=service=<value>`) and
  an **attribute-filtered** walk. `DRAIN_FILTERS` already exists
  (`scripts/mixed-workload.mjs`), so no harness work is required.

Drop one index at a time — one variable per run, per the measurement standard
in `agents.md`.

**The middle option, to price alongside the drop:** replace the whole-bag
`jsonb_path_ops` GIN with a narrow partial expression index on specific hot
keys. `HOT_ATTRIBUTE_KEYS` and `ensureHotAttributeIndexes` in
`src/db/migrate.ts` already implement this, so it is configuration rather than
new code. Note that a hash index is a live option for the equality-only case on
PostgreSQL 16 — see item 6 of §4.

### 2. Narrow the attribute index rather than dropping it

Follows directly from item 1's attribute-filtered walk. If that walk shows real
demand, the whole-bag GIN is the wrong shape for it and a partial index on the
specific key is the cheaper way to serve it. If the walk shows no demand, this
item collapses into item 1's drop.

### 3. Binary `COPY` instead of CSV

The app serialises CSV text and PostgreSQL then parses and validates it, inside
the statement that owns 71.3% of database time. Binary framing removes the
escaping on the app side and the text parse on the database side. The app-side
saving is no longer interesting — the application has slack — but **the
database-side parse has never been measured** and it is the only item here that
attacks the dominant statement while giving up nothing.

Effort is the highest of phase 1: `pg-copy-streams` offers no binary mode, so
the framing is owned code.

### 4. `max_wal_size` 2 GB → 8 GB

At the measured ~9.5 MB/s, 2 GB fills in about 3.5 minutes, so checkpoints are
size-driven rather than reaching the 15-minute timeout, and each one is followed
by a fresh round of full-page images (16,141 measured in a 90 s run). Raising
the ceiling is one compose line and changes no durability property.

Add `log_checkpoints=on` for the before/after run so the trigger is visible
rather than inferred.

### 5. `wal_buffers = 16MB`

Currently unset, so it defaults to 1/32 of `shared_buffers` = 8 MB. This is a
write-heavy service and 16 MB is the standard recommendation for that case
(HP p. 148, via the book review). Costs 8 MB of shared memory inside the 1 GB
container.

**Take this as a freebie riding along with another run, never as a campaign of
its own** — at a 96.2% buffer hit ratio the expected effect is small.

---

## 3. Phase 1 exit — what decides what happens next

Phase 1 is complete when items 1–5 have been measured to the seven-rule standard
and written up in `docs/test_results/` with a `bench/results/<date>-<topic>/`
entry.

The exit question is single: **how much of the per-row database cost did phase 1
remove, and is PostgreSQL still the constraint?**

- If PostgreSQL is no longer saturated in the mixed workload, the constraint has
  moved again and phase 2 must be re-ranked before it is run.
- If PostgreSQL is still the constraint, the remaining per-row cost is
  structurally WAL, and the only lever left of that size is a **durability
  trade** (`UNLOGGED`). That is priced in `search_rnd/BOOK-OPTIMIZATION-REVIEW.md`
  §5 and is **an owner decision, not a tuning step** — this repository's own
  gates verify a "200 only after a durable commit" guarantee that an unlogged
  table cannot sit under. Do not take it on an agent's initiative.

---

## 4. Phase 2 — measurement gaps, not tuning

**Do not start these until phase 1 reports.** They are listed now so the
sequence is on record and so nobody rediscovers them as new work.

These four answer a different question from phase 1 — *which properties of the
read side have never been measured?* — so they are not ranked by database CPU.

### 6. Background-writer tuning — measure, direction unknown

`buffers_backend` **38,055** against the checkpointer's **919** and the
background writer's **18,238**: writer backends are stalling to find clean
buffers instead of the background writer staying ahead of them.
`bgwriter_lru_maxpages` and `bgwriter_delay` are untouched defaults.

**The book review supplies a caution this plan did not originally have** (HP
p. 210): making the background writer more aggressive usually produces a net
loss in raw throughput without improving latency either. So this is a
measurement whose direction is genuinely unknown, not a tuning step with an
expected sign. Take a `pg_stat_bgwriter` snapshot pair around one mixed run.

### 7. Per-request read-after-write probe

`plan/05-BENCHMARK-PROTOCOL.md` requires read-after-write probing and **no
harness in this repository implements it**. What exists is cohort visibility
inside a window (99.6–99.8% on the shipped stack), which is the same anomaly
family at batch scale but not a write-then-read-the-same-row test. The only 1:1
numbers on record predate the stack swap.

Add a probe mode to `scripts/mixed-workload.mjs`: after each accepted batch,
query for one of its own rows and record found/not-found plus latency, under
sustained load. See `search_rnd/BOOK-OPTIMIZATION-REVIEW.md` §7.1 for the
guarantee this tests and why the ingest queue threatens it.

### 8. Assert ordering and duplicates on the walk under ingest

The drain correctness gate — ordering, duplicates, true end — has only ever run
**at rest**. The mixed-workload harness already walks while writes are flowing;
it simply does not assert on that walk. This is close to free and closes the
gap between what the gate claims and the condition the service runs in.

### 9. Closed-loop mode for the harness

`scripts/mixed-workload.mjs` is deliberately **open-loop**, and that was the
right call: a closed-loop client throttles itself when the server slows, so no
backlog forms and the effect being measured stays invisible (this is why
`benchmark.mjs` could not see the read-path collapse). `search_rnd/BOOK-
OPTIMIZATION-REVIEW.md` §3.4 records the book citation for the rule.

But open-loop is now the *only* shape we can produce, and a self-throttling
client is a real-world shape too. A closed-loop mode would let us characterise
both without giving up the open-loop default.

---

## 5. Rules for this branch

- **One variable per run.** Drop one index, or change one setting — never two.
- **The seven-requirement measurement standard in `agents.md` applies to every
  number that informs a decision.** Interleaved, ≥3 repeats per side, clean
  volume, build verified in-container, one stack up at a time, report the
  spread. A run missing one of these is a screen, not evidence.
- **Both halves or no decision.** Any index change reports its read cost as
  well as its write gain.
- **Do not "fix" a disappointing number. Record it.** Two predictions were
  overturned by measurement on 2026-08-17/18 and both are recorded in
  `agents.md`; that is the standard.
- **Raw output goes to the private analysis repo in the same session**
  (`plan/internal/SANITIZATION.md` §7). `bench/raw/` is gitignored.
- **Run the sanitization checks before every commit and push.**
- **Do not merge to `main` without the owner's decision**, and do not take the
  durability trade in §3 on your own initiative.

---

## CHANGES

- 2026-08-18: created. Phase 1 (items 1–5) planned after
  `docs/test_results/postgres-profile.md` moved the constraint onto PostgreSQL;
  phase 2 (items 6–9) recorded but explicitly not scheduled. Items 5 and 6 carry
  corrections contributed by `search_rnd/BOOK-OPTIMIZATION-REVIEW.md`.
