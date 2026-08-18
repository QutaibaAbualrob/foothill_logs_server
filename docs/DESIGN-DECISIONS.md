# Design decisions

One entry per deliberate choice: what was chosen, what was rejected, the
measured reason, what it gives up, the test that guards it, and the measurement
that justifies it.

**This file is indexed by decision.** `plan/01-ARCHITECTURE.md` describes what
the system *is*; `docs/test_results/` records *when* things were measured; this
file records *why*.

**Rules for this file — read before editing.**

1. **Any agent or human making a design choice on this project adds an entry
   here in the same session.** A choice that only exists in a commit message or
   a results file is invisible to the next reader.
2. Every entry carries **`Verified by`** (an automated test, gate, or harness)
   and **`Evidence`** (the measurement). If either is missing, say so
   explicitly — an unverified decision is a known risk, not a blank line.
3. **Append, never silently rewrite.** If a decision is reversed, keep the
   original and add the reversal with its evidence. That a choice was tried and
   abandoned is part of the design.
4. Point, don't restate. Numbers live in `docs/test_results/` and stay
   maintained in one place.

---

## 1. Runtime and framework: Fastify on Bun

**Chosen:** Fastify 5 on Bun 1.3.14.
**Rejected:** Express on Node 22.18 (the original stack), Fastify on Node,
Express on Bun.
**Why:** the full 2×2, one variable at a time, at batch 33:

| | Express | Fastify | framework gain |
| --- | ---: | ---: | ---: |
| Node | 8,603 logs/s | 11,233 | +30.6% |
| Bun | 18,361 | 20,095 | +9.4% |
| runtime gain | +113% | +79% | |

The runtime is the larger effect by an order of magnitude, and **the two are not
additive** — Bun's HTTP layer is already fast, so less framework overhead
remains for Fastify to remove.

The decisive number was not throughput but the read path under concurrent
ingest: drain 19.6–21.7 pages/s against 0.96–1.09, and 99.6–99.8% of rows
visible in a 30 s window against 14.5–15.3%. Express was not merely slower, it
was **starved** — zero pages completed for ~15-second stretches while ingest
held the CPU.

**Gives up:** Bun's heap is JavaScriptCore's, so there is no
`--max-old-space-size` equivalent and `mem_limit` is the only ceiling — which
makes peak RSS the number to watch (91–106 MiB on ingest, 147 MiB on the drain
path, against a 256 MiB cap). The image runs TypeScript directly, so there is no
build step to catch a type error; `npm run typecheck` in CI is the only thing
between a type error and production.
**Verified by:** the whole suite on both runtimes in CI (`npm test` on tsx and
`bun test`), plus the Bun image built and smoked — `.github/workflows/ci.yml`.
**Evidence:** [`fastify-bun-results.md`](test_results/fastify-bun-results.md),
[`mixed-workload-baseline.md`](test_results/mixed-workload-baseline.md),
`bench/results/2026-08-18-mixed-workload/`.

## 2. Range partitioning by timestamp

**Chosen:** `logs PARTITION BY RANGE (timestamp)`, monthly partitions plus a
`DEFAULT` partition, with per-partition autovacuum tuning.
**Rejected:** a single large table; distributed sharding.
**Why:** retention becomes `DROP TABLE` on a partition instead of a
million-row `DELETE`, which would generate WAL proportional to the data removed
and leave the table needing vacuum. Partition pruning and per-partition
autovacuum are secondary benefits.
**Gives up:** horizontal capacity — this is single-node partitioning, not
sharding. A non-empty `DEFAULT` partition is treated as a defect, because rows
landing there fall outside the monthly drop schedule and are never reclaimed.
**Verified by:**
[`test/integration/retention.test.ts`](../test/integration/retention.test.ts) —
*"one retention pass drops the expired partition, its raw rows, and rollup
counts while recent rows survive"*.
**Evidence:** `src/db/migrations/001_init.sql`, `src/retention/worker.ts`.

## 3. Keyset cursor pagination, not `OFFSET`

**Chosen:** keyset pagination on `(timestamp DESC, id DESC)`, with an opaque
HMAC-signed cursor carrying the last key plus a hash of the active filters.
**Rejected:** `LIMIT`/`OFFSET`.
**Why:** `OFFSET n` makes the database walk and discard `n` rows, so page cost
grows with depth — unusable for a drain over millions of rows. The `id`
tiebreaker makes ordering deterministic across rows sharing a timestamp, and the
filter hash means a cursor cannot be replayed against a different filter set to
skip or duplicate rows.

**Verified at the boundary that matters:** a 1,511,600-row walk returned 0
duplicates, 0 ordering violations, and unique rows equal to `COUNT(*)`, across a
**400-row tied-timestamp group spanning ids 999,801–1,000,200**. A walk that
stopped below a million rows would not have crossed it.

**Gives up:** no random access to page *n* — clients must walk. Cursors are
signed with `CURSOR_SECRET`; unset, the process generates a random secret at
startup and cursors minted before a restart are rejected.
**Verified by:** [`test/unit/query.test.ts`](../test/unit/query.test.ts) —
*"cursor round-trips exact microseconds and is bound to filters"* and *"cursor
rejects tampering"*.
**Evidence:** [`drain-fastify-bun.md`](test_results/drain-fastify-bun.md),
`bench/results/2026-08-18-fastify-bun-drain/`.

## 4. `COPY FROM STDIN` with group-commit batching

**Chosen:** accumulate entries in a bounded in-process queue, then write each
batch with a single `COPY … FROM STDIN`.
**Rejected:** per-row `INSERT`; multi-row `INSERT … VALUES`.
**Why:** `COPY` is the cheapest bulk path PostgreSQL offers, and group commit
amortises transaction and WAL-flush overhead across a batch — the profile shows
1,778 `COPY` statements carrying 1,349,964 rows, about 759 rows per statement.
**Gives up:** acknowledgement latency. A `200` waits for the batch to commit,
so `BATCH_DELAY_MS` trades latency against throughput. The queue is capped in
**both rows and bytes**, because a byte cap alone permits an unbounded row count
and vice versa; past the cap the service sheds with `503` rather than growing
memory.
**Verified by:** [`test/unit/batcher.test.ts`](../test/unit/batcher.test.ts) —
`WriteBatcher` against a fake repository that can block, covering batch
formation, the caps, and backpressure.
**Evidence:** [`postgres-profile.md`](test_results/postgres-profile.md) §2,
[`batch33-and-cpu-profile.md`](test_results/batch33-and-cpu-profile.md).

## 5. A transactional rollup table, not a materialized view or an app cache

**Chosen:** `logs_agg_1m`, a real table upserted **inside the ingest
transaction** (`ON CONFLICT … DO UPDATE SET count = count + EXCLUDED.count`).
**Rejected:** `MATERIALIZED VIEW` with periodic `REFRESH`; an in-process
aggregate cache; aggregating raw rows on read.
**Why:** the rollup answers aggregate queries for **0.2% of database time**
(0.10 ms per batch to maintain, 7,005 index scans on its primary key to serve).
A materialized view's staleness window is the disqualifier, not its cost: the
contract is that a `200` means the row is queryable, and a periodic refresh
breaks that. An in-process cache has the same staleness problem plus a memory
cap to manage, and would be competing for the same 0.2%.
**Gives up:** the rollup stores only the `service` and `level` dimensions, so a
`q` substring search or an attribute filter must still scan raw rows. Partial
edge minutes are answered by small raw queries around the rollup's whole-minute
interior. The rollup must also share the retention job, or it would outlive the
rows it summarises.
**Verified by:**
[`test/integration/aggregate.test.ts`](../test/integration/aggregate.test.ts)
(rollup correctness against seeded rows) and
[`test/integration/retention.test.ts`](../test/integration/retention.test.ts)
(rollup counts dropped together with the partition).
**Evidence:** [`postgres-profile.md`](test_results/postgres-profile.md) §2.

## 6. The index set: four structures reduced to two, by measurement

**Chosen:** the primary key `(timestamp, id)`, plus a `jsonb_path_ops` GIN on
`attributes` with `fastupdate = off`. Optional per-key partial indexes exist but
ship disabled (`HOT_ATTRIBUTE_KEYS` empty).
**Rejected:** `logs_service_level_page_idx` on
`(service, level, timestamp DESC, id DESC)` — declared in migration `001`,
dropped in migration `004`. Also rejected: a covering index with
`INCLUDE (message, attributes)`.

**Why — this is the entry that shows the method.** The profile found *both* the
service index (116 MB) and the GIN (57 MB) taking **zero scans**, maintained on
every inserted row inside the `COPY` that owns 71.3% of database time. They
looked identical. Measured against the query shape each exists to serve, they
priced out completely differently:

| Index removed | Its own query shape | Result |
| --- | --- | --- |
| `logs_service_level_page_idx` | service-filtered cursor walk | **no regression** — 12.6–13.1 pages/s before, 12.4–14.4 after; every band overlapping |
| attributes GIN | selective attribute point lookup | **42.7× slower at p50** — 2.4–2.7 ms becomes 106.1–110.6 ms |

One was deleted, one kept. Deleting the service index bought **−18% WAL per
row** and **+12.4% / +25.1%** ingest throughput at batch 33 / 200, every
normalized band separated. The GIN's record is the mirror image: migration `002`
measured it taking an attribute lookup from ~158 ms to ~0.4 ms for about 4.5% of
ingest throughput.

The service index survived removal because the read set is RAM-resident (96.2%
buffer hit ratio), which makes a backward primary-key scan discarding three rows
in four cheaper than maintaining a fourth B-tree — and the CPU freed by dropping
it pays for the extra rows examined.

**Gives up:** a deployment paging heavily by `service` over a table much larger
than memory could reverse the first result; this entry rests on a measurement,
not a law. `fastupdate = off` pays the GIN's tree insert up front rather than
letting reads scan a pending list — the right trade only while reads keep pace
with writes.
**Verified by:** no unit test asserts the index *set* (it is schema, not
behaviour). Query correctness across the filters these indexes serve is covered
by [`test/unit/query.test.ts`](../test/unit/query.test.ts) and
[`test/integration/aggregate.test.ts`](../test/integration/aggregate.test.ts);
migration `004` applying on a clean volume is verified by the gate run recorded
in the results file.
**Evidence:** [`index-removal.md`](test_results/index-removal.md),
`bench/results/2026-08-18-index-removal/runs.csv`,
`src/db/migrations/004_drop_service_level_page_idx.sql`.

## 7. `synchronous_commit = off`, but WAL kept

**Chosen:** `SET LOCAL synchronous_commit = off` per write transaction; the
`logs` table stays fully WAL-logged.
**Rejected:** `UNLOGGED` tables; `fsync = off`; `full_page_writes = off`.
**Why:** asynchronous commit removes the WAL *flush* wait from the write path
while keeping crash recovery intact. `UNLOGGED` would remove WAL work
entirely — the single largest write-path lever available — but an unclean
PostgreSQL crash **truncates the whole table**, demonstrated locally at 280,445
committed rows becoming 0. The repository's own gates assert that a `200` means a
durable commit, so the trade is incompatible with the stated contract and is an
owner decision, not a tuning knob.
**Gives up:** with asynchronous commit a crash can lose the most recent
already-acknowledged transactions. That is a real, deliberate exposure, which is
why a durable profile exists rather than the choice being hidden.
**Verified by:** `scripts/failure-drill.sh` (`npm run drill`) — SIGTERM
mid-ingestion must exit 0 and every acknowledged row must be present
afterwards; last run 391,400 of 391,400 rows persisted.
**Evidence:** `docker-compose.yml`, `src/ingest/repository.ts`,
`plan/01-ARCHITECTURE.md` §10 invariant 1.

## 8. Role-separated connection pools with a read statement timeout

**Chosen:** three pools — write (2), query (8), maintenance (1) — each with its
own `application_name` and statement timeout; the query pool's is 5,000 ms.
**Rejected:** one shared pool; an external pooler such as pgBouncer.
**Why:** reads cannot exhaust the connections writes need, and no single read
can hold a backend indefinitely. The write pool is deliberately small — two
concurrent `COPY` streams against a 1-CPU database, because more writers contend
rather than add capacity. The query timeout is a backstop rather than the primary
defence (attribute filters are index-backed), but a `q` substring search is still
a scan and one of those should not occupy a backend for ten seconds. An external
pooler adds a network hop, not capacity, at ten total connections.
**Gives up:** a legitimate slow query is killed at 5 s, and the write path
cannot borrow idle read connections under a write spike.
**Verified by:** [`test/unit/pools.test.ts`](../test/unit/pools.test.ts) — every
driver and SQLSTATE form of "database unavailable" maps to `503` +
`Retry-After` rather than `500`. The test carries the reason: listing only
`ENOTFOUND` mapped a `SERVFAIL` resolver's `EAI_AGAIN` to `500` for the
identical outage. Endpoint-level degradation is re-checked by `npm run drill`.
**Evidence:** `src/db/pools.ts`, `docker-compose.yml`.

## 9. Ingest validation: per-entry, with an opt-in age floor

**Chosen:** validate each entry independently, mirroring the database's own
limits (`service` ≤ 255, `message` ≤ 65536, four known levels); an invalid entry
never rejects a valid sibling. A retention-window age floor exists but is **off
by default** (`MAX_LOG_AGE_DAYS=0`).
**Rejected:** rejecting a whole batch on one bad entry; enforcing the age floor
by default.
**Why:** a log shipper batching from many sources should not lose 32 good
entries to one malformed one. The age floor is more honest than accepting a
backdated row and deleting it on the next retention pass — a row older than the
window lands in the `DEFAULT` partition, which the monthly drop never
reclaims — but it is **a change to the ingest contract**: a client backfilling
history gets a per-entry rejection where it previously got a `200`. That makes
it opt-in.
**Gives up:** with the floor off (the default), backdated rows accumulate in the
`DEFAULT` partition and are not covered by partition-drop retention.
**Verified by:**
[`test/unit/validation.test.ts`](../test/unit/validation.test.ts) — *"validation
accepts good entries and preserves rejected indexes"* plus the bounds and age
cases; end to end by `npm run smoke` and the reliability checks.
**Evidence:** `src/ingest/validation.ts`,
`src/db/migrations/003_ingested_at_and_field_bounds.sql`, `docker-compose.yml`.

## 10. Migrations must not rewrite the table at startup

**Chosen:** `ingested_at` is added in **two statements** — add the column
nullable, then `SET DEFAULT clock_timestamp()`. Length constraints are added
`NOT VALID`.
**Rejected:** the obvious `ADD COLUMN … NOT NULL DEFAULT clock_timestamp()`.
**Why:** `clock_timestamp()` is VOLATILE, and PostgreSQL only stores a default
in the catalog when it is non-volatile. The one-liner therefore rewrites **every
partition** under `ACCESS EXCLUSIVE` — and `migrate()` runs at startup before
the service serves traffic, turning a routine restart into an outage
proportional to table size. The two-statement form is catalog-only.
`ADD CONSTRAINT … NOT VALID` is legal on a partitioned table and skips the
validation scan for the same reason.
**Gives up:** `NOT VALID` constraints are not enforced against pre-existing rows
until someone runs `VALIDATE CONSTRAINT`; new rows are checked.
**Verified by:** **no automated test asserts this property** — this is a known
gap. It was verified manually against PostgreSQL 16.4 on a populated partitioned
table, and every migration is exercised for *applying cleanly* by the two
integration files (both call `migrate()`), but nothing fails the build if a
future migration reintroduces a rewriting `DEFAULT`. A guard would need to assert
`convalidated = false` and catalog-only DDL.
**Evidence:** `src/db/migrations/003_ingested_at_and_field_bounds.sql` (the
reasoning is in the file header).

## 11. What was deliberately not built

**Rejected, each for its own recorded reason:**

| Not built | Why not |
| --- | --- |
| Application cache (Redis / in-process) | The only cacheable surface is aggregates, and the rollup already answers those for 0.2% of database time. Reads are a one-pass cursor walk with no repetition to exploit, and PostgreSQL is CPU-bound at a 96.2% buffer hit ratio, not I/O-bound |
| Larger `shared_buffers` | Same reason: 96.2% hit ratio, three `DataFileRead` samples in a whole run. The lever is *less work*, not more memory |
| Replication / read replicas | One server. WAL shipping and standby management would land on the same 1-CPU budget that is currently the constraint |
| Vertical scaling | The resource envelope is fixed. A raised-cap run exists in `bench/raw/` as a **diagnostic control only**, to separate real cost from CFS throttle stall — not as a proposed configuration |
| Covering index for the page query | Measured out: the page query is already served by backward primary-key scans at 38 buffer hits and 0.57 ms per 1,000 rows. The cure roughly doubles index size on the write path that owns 71.3% of database time |

**Verified by:** not applicable — these are absences. The measurements that
justify each are the guard against re-adopting them without new evidence.
**Evidence:** [`postgres-profile.md`](test_results/postgres-profile.md),
[`index-removal.md`](test_results/index-removal.md).

## 12. The measurement standard is itself a design choice

**Chosen:** eight rules a result must satisfy before it can inform a merge, a
revert, or a claim — interleaved builds, ≥3 repeats per side, clean volume,
build verified from inside the container, one variable, one stack up at a time,
report the spread, and **pair the sides**.
**Rejected:** single before/after runs; trusting a branch name.
**Why:** each rule exists because its absence produced a wrong answer here.
Measured noise is ~6% within a session and ~11% across sessions — enough to
invent a 10% effect from nothing. A commit that landed on the wrong branch once
inverted an entire A/B and produced a confident, backwards conclusion, hence
verifying the build from inside the container. A failure drill passed for weeks
by sending `SIGTERM` to a container that did not exist, with the error swallowed
by `|| true`, hence harnesses resolving containers from the compose project and
failing loudly.

The eighth rule is the newest and most load-bearing: **a write-path result
without its read-path pair is not a decision.** Entry 6 is why. Dropping two
indexes cut database CPU 30% and WAL 56% — a result that says nothing about
whether they could be dropped, because the workload that produced it never ran
the filtered reads they exist to serve. Measuring the paired side against **the
shape the structure serves** is part of the rule: the default workload here is
an unfiltered walk, which touches neither index and would have reported "no
regression" for both.
**Gives up:** a decision costs 6 to 30 runs instead of 2. Entry 6 took 30.
**Verified by:** `scripts/mixed-workload.mjs` (open-loop dispatch, visibility
measured under sustained load), `scripts/capture-resources.mjs` and
`scripts/failure-drill.sh` (compose-resolved containers, fail loudly).
**Evidence:** `agents.md` "The measurement standard",
`plan/05-BENCHMARK-PROTOCOL.md` §1.

---

## CHANGES

- 2026-08-18: created. Twelve entries assembled from the existing architecture,
  results and plan files, reorganised by decision rather than by component or
  date. Each entry links the test or gate that guards it and the measurement
  that justifies it; entries 6, 10 and 11 record explicitly where no automated
  guard exists.
