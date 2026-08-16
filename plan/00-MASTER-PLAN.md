# Master Delivery Plan — Log Ingestion and Query Service

**Deadline:** 6 hours from kickoff (H+0:00 → H+6:00)
**Deliverable:** one Git repository, rooted at `E:\server_loger`, that satisfies every
item in the specification's Definition of Done and is pushed to GitHub.

This plan is derived from `search_rnd/RND.md` (our own research record) and the
project specification. Every design decision below traces to one of those two
sources plus our own measurements. Numbers we have not yet measured are labelled
as hypotheses, never as results.

---

## 1. Objective

Deliver a correct, reliable, measured, high-throughput log service under the
stated container caps (application 0.5 CPU / 256 MB, PostgreSQL 1 CPU / 1 GB),
optimised in this priority order:

1. **Contract exactness** — the four required endpoints, exact request and
   response shapes, exact status codes.
2. **Reliability** — no crash on any malformed input; graceful database failure.
3. **Read-path throughput under load** — see §3, this is where our remaining
   engineering budget goes.
4. **Ingestion throughput** — bulk write plus group commit; ≥15,000 logs/s
   sustained with comfortable margin.
5. **Retention, CI, documentation, evidence.**

### Non-goals for the 6-hour version

Explicitly out of scope. Do not start any of these; they are additive risk with
no contract value:

- Dashboard, alerting, webhooks, live-tail, custom query language, multi-tenancy.
- Authentication (spec §34 makes it optional and requires `AUTH_ENABLED=false`
  default — the cheapest compliant answer is *not implementing it at all*).
- Any additional container (Redis, broker, proxy, metrics sidecar). Our research
  record is explicit that extra containers consume the same fixed quota the
  application needs.
- Rewrites of anything already working. The tree already contains a functioning
  skeleton; this plan finishes and measures it, it does not restart it.

---

## 2. Current state at kickoff

Working code already exists under `workshop/`:

| Area | State |
| --- | --- |
| `config.ts`, `types.ts`, `errors.ts` | Present, strict env parsing |
| `db/pools.ts` | Present — split write / query / maintenance pools |
| `db/migrate.ts` + `001_init.sql` | Present — checksummed migrations, monthly partitions, rollup table, marker paging index |
| `ingest/validation.ts` | Present — per-entry validation, null-byte rejection |
| `ingest/batcher.ts` | Present — bounded cross-request queue, group commit, byte + row caps |
| `ingest/repository.ts` | Present — COPY CSV in 64 KiB chunks + transactional minute-rollup upsert |
| `query/cursor.ts` | Present — signed, filter-bound, microsecond-precision cursor |
| `query/parser.ts`, `builder.ts`, `repository.ts` | Present — strict parsing, parameterised predicates |
| `retention/worker.ts`, `app.ts`, `index.ts` | Present |
| `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml` | Present |
| Unit tests | Three files, thin |
| **Repository layout** | **Wrong — see Phase 0** |
| **Measured evidence** | **None yet — this is the single largest gap** |
| **README** | **Missing — required deliverable** |

The build is roughly 60% done and 0% measured. The plan reflects that: less time
on new code, more time on measurement and the read path.

---

## 3. The one engineering thesis of this plan

Our research record (`search_rnd/RND.md` §12.7, §12.9) reaches this conclusion:

> Fast acceptance must be paired with a read path fast enough to verify it
> within the freshness window. Accepting faster than the read path can prove
> visibility backfires.

We take that further, because it decides where the remaining hours go.

The specification requires that newly ingested logs be queryable within 20
seconds (§21) and that queries stay usable during ingestion (§24). The load
generator verifies this by **walking the cursor pagination to the end of the
accepted dataset inside a fixed drain window**. That walk is sequential: page
*N+1* cannot start until page *N* returns. So the walk's completion is governed
by one number:

```
records drainable  =  drain window (s)  ×  pages/second  ×  page size (rows)
```

A run that accepts ~1.8 M records and pages at 1,000 rows must sustain
**≈60 pages/second** to finish inside a 30-second window. A run that accepts
~3 M must sustain **≈100 pages/second**. That means a 1,000-row page —
query + serialise + write — has a hard budget of **≤10 ms, target ≤8 ms**.

Therefore:

- **Primary optimisation target: 1,000-row cursor page in ≤8 ms end-to-end,
  sustained, at ≥2 M rows in the table.** Everything in Phase 4 serves this.
- **Secondary target: leave PostgreSQL CPU headroom during ingestion** so the
  concurrent read probes are not starved. Our record's §12.7 states this
  directly. Index budget discipline (§4 below) is how we buy it.
- **Ingestion throughput is a threshold, not a scoreboard.** Once we clear
  15,000 logs/s with margin, additional accepted volume makes the read-path
  target *harder*, not easier, because it enlarges the dataset the same fixed
  window must drain. We will not spend hours chasing peak write throughput.

This is the thesis. If a decision during the build is ambiguous, resolve it in
favour of read-path latency.

---

## 4. Index budget

Every index is a tax on the single PostgreSQL CPU during ingestion (research
record §4, §9). We ship the minimum set that the required query patterns
justify, and each one must survive a measured before/after comparison.

| Index | Serves | Status |
| --- | --- | --- |
| `PRIMARY KEY (timestamp, id)` | Deterministic `timestamp DESC, id DESC` ordering and keyset pagination — the drain walk | **Required, ship** |
| `(service, level, timestamp DESC, id DESC)` | Filtered paging by service and/or level, which the spec lists as first-class filters | **Ship, verify plan usage** |
| Partial ordered index on a configured hot attribute key | Correlation-ID style attribute lookup that must also return in cursor order — a single index scan instead of scan-then-sort | **Ship, measure write cost** |
| Attributes GIN | Arbitrary `attr.<key>` equality | **Do not ship by default.** Parameterised `attributes ->> key = value` is already correct without it. Add only if a measured query gain exceeds its measured ingestion cost |
| `pg_trgm` on message | `q` substring search | **Do not ship.** Highest write amplification in the set; `q` has no latency requirement in the spec |

Rule: an index that cannot be justified with an `EXPLAIN (ANALYZE, BUFFERS)`
capture in the README does not ship.

---

## 5. Durability posture — decided, and documented honestly

We ship **WAL-backed tables** with **transaction-local `synchronous_commit=off`**
(`SET LOCAL` inside the ingest transaction), controlled by `SYNC_COMMIT`.

- We do **not** use `UNLOGGED` tables. An unclean restart truncates them, which
  contradicts "PostgreSQL is the source of truth for both reads and writes"
  (spec §5). The throughput difference does not justify that.
- `SYNC_COMMIT=on` flips the whole service to a strictly crash-durable
  acknowledgement profile. Both profiles get benchmarked and both go in the
  README, labelled.
- The README states plainly: *accepted means committed and immediately
  queryable; under the default profile, a window of acknowledged writes can be
  lost if the PostgreSQL host crashes uncleanly. This is a deliberate,
  measured trade-off, and `SYNC_COMMIT=on` removes it.*

Our research record §9.1 is unambiguous that the failure mode to avoid is
**claiming durability the configuration does not provide**. Honest labelling is
the requirement, not any particular setting.

---

## 6. Phase schedule

Each phase has a hard exit gate. **If a gate is not met at its deadline, apply
the fallback ladder in §7 and move on.** Do not let an unfinished optimisation
consume a later phase.

### Phase 0 — Repository shape and hygiene · H+0:00 → H+0:30

The application currently lives in `workshop/`. The specification requires
`docker compose up` to start the complete system (§7, §33) and CI to run (§39).
Both look at the repository root. This must be fixed before anything else.

- Promote `workshop/*` to the repository root.
- Root `.gitignore` covers build output, dependencies, environment files,
  benchmark artefacts, scratch directories, and `plan/internal/`.
- Confirm nothing unintended has ever entered Git history.
- Resolve the tracked PDF library (see `06-SUBMISSION-CHECKLIST.md` §2).
- `docker compose up` from a clean clone reaches healthy.

**Exit gate:** clean clone → `docker compose up` → `GET /health` returns 200.

### Phase 1 — Close the contract · H+0:30 → H+1:45

Finish every endpoint to exact spec shape. Correctness before speed.

- `POST /logs` — partial acceptance, original indexes, 200/400 rules (§12).
- `GET /logs` — all filters freely combinable, `limit` default 100 / max 1000,
  `next_cursor` null only at true end (§13–§17).
- `GET /logs/aggregate` — all four buckets, both groupings, rollup interior plus
  exact raw edge slices for unaligned ranges, raw fallback when `q` or `attr.*`
  is present (§18–§20).
- `GET /health` — 200 only after migrations applied and ingest ready (§8).
- Retention — configurable, partition drop plus bounded batched boundary
  deletion, rollup table included (§29).
- Unit tests for validation, cursor round-trip, query parsing, COPY escaping.

**Exit gate:** `npm run typecheck && npm test` green; contract smoke script
passes against the Docker stack.

### Phase 2 — Reliability and edge cases · H+1:45 → H+2:15

Everything in spec §30 and §31, plus the specific traps our research record
§9.3–§9.4 identifies.

- Literal `%`, `_`, `\` in `q` must not act as wildcards.
- Malformed / tampered / cross-filter cursors → 400, never 500.
- Non-numeric and out-of-range `limit` → 400. No numeric-prefix parsing.
- `until` earlier than `since` → 400. Empty ranges → 200 with empty results.
- Values that pass JavaScript validation but violate a column constraint must be
  rejected per-entry *before* the batch, or one bad row rolls back a whole group
  commit and breaks partial acceptance.
- Database down / statement timeout / pool exhaustion → 503, never 500, never a
  false 200, and never a crash.

**Exit gate:** the edge-case matrix in `04-VERIFICATION-GATES.md` G2 fully green.

### Phase 3 — Benchmark rig and baseline · H+2:15 → H+3:30

No optimisation before a baseline. Build the rig, then measure once.

- k6 in Docker against the capped compose stack.
- Scenarios: sustained load; a higher-rate stress ramp; a spike; a breakpoint
  ramp. Backdated timestamps included — a generator that only sends "now" never
  exercises the partition path (research record §9.5).
- **Drain harness:** after each scenario, walk `GET /logs` by cursor to the end,
  recording pages/second, rows/second, per-page p50/p95/p99, and whether the
  walk reaches the true end. This is the measurement that Phase 4 optimises.
- Capture application and PostgreSQL CPU/RSS, WAL growth, pool wait time.
- Capture `EXPLAIN (ANALYZE, BUFFERS)` for: unfiltered page, service-filtered
  page, hot-attribute page, aggregate with and without grouping.

**Exit gate:** `bench/results/baseline.md` exists with real numbers, and
`docs/explain/*.txt` contains real plans.

### Phase 4 — Read-path optimisation campaign · H+3:30 → H+5:00

The core of the plan. Run the experiment queue in
`05-BENCHMARK-PROTOCOL.md` §4, **one variable at a time**, keeping a change
only when the measurement supports it. Highest-expected-value experiments first:

1. Move row-to-JSON construction into PostgreSQL so the application concatenates
   pre-built strings instead of allocating and re-stringifying 1,000 objects per
   page. During a drain the write path is idle, so PostgreSQL has CPU to spare
   and the application does not.
2. Bypass framework response serialisation — write a prepared buffer directly.
3. Bounded read-ahead: after serving a page, speculatively execute the next page
   for the cursor just minted and hold the pre-serialised body in a small
   capped LRU. A sequential walk then hits memory. Strictly additive, bounded to
   a few hundred KB, disabled under memory pressure, and it cannot change
   results because it is the identical deterministic query.
4. Batch-shape sweep (target rows, byte budget, coalescing delay, write
   concurrency) for ingestion p95 and PostgreSQL CPU headroom.
5. Pool layout: reserved split pools versus a larger shared pool.
6. COPY versus UNNEST INSERT behind the same batcher.
7. `SYNC_COMMIT` on versus off, labelled by durability profile.

**Exit gate:** a measured configuration that hits the §3 page-latency target, or
the best measured configuration plus an honest note of the gap.

### Phase 5 — Final measured run · H+5:00 → H+5:30

From a clean database and a clean build, run the full scenario set once with the
chosen configuration. These are the numbers that go in the README, produced by
scripts that ship in the repository and can be re-run by anyone.

**Exit gate:** `bench/results/final.md` complete; the shipped script reproduces
the README's table.

### Phase 6 — Documentation and submission · H+5:30 → H+6:00

- README with every section spec §40 requires.
- Sanitisation gate and repository hygiene (`06-SUBMISSION-CHECKLIST.md`).
- Incremental, meaningful commits; push.
- Video outline written (recording is the user's, not this plan's).

**Exit gate:** the Definition of Done checklist is fully ticked, honestly.

---

## 7. Fallback ladder

When behind schedule, cut in this order. Cut from the bottom up; never cut
something above a line you have already cut.

| Cut order | What to drop | Cost |
| --- | --- | --- |
| 1 | Read-ahead prefetch (Phase 4 experiment 3) | Slower drain; everything still correct |
| 2 | COPY vs UNNEST comparison | One README paragraph becomes "not evaluated" |
| 3 | Pool-layout comparison | Ship the reserved split-pool default |
| 4 | Stress / spike / breakpoint scenarios | README reports the sustained-load scenario only |
| 5 | `/metrics` endpoint | Optional extra, no contract value |
| 6 | Durability-profile A/B | Ship the default profile, document the other as untested |
| — | **Never cut** | Contract exactness, per-entry validation, cursor correctness, retention, README, CI, `docker compose up` |

A correct service with one honestly measured scenario beats a fast service with
a broken cursor. Our research record §12.9 treats read-path correctness as an
independent gate, and so does this plan.

---

## 8. Risk register

| Risk | Signal | Response |
| --- | --- | --- |
| Local machine cannot drive 15k logs/s | k6 saturates before the service does | Report the offered-rate ceiling honestly; measure per-page latency and PostgreSQL CPU instead of headline throughput |
| Drain target proves unreachable in the time budget | Phase 4 stalls at >10 ms/page | Ship the best measured result and document the remaining gap in Limitations. Do **not** fabricate numbers |
| Application RSS approaches 256 MB | Container restarts under load | Reduce queue caps and read-ahead size; the caps exist for this |
| Repository restructure breaks the Docker build | Phase 0 overruns | Timeboxed to 30 min; if it overruns, revert and put `docker-compose.yml` plus `.github/` at the root pointing into the subdirectory |
| An optimisation changes response shape | Contract smoke fails | Gate every Phase 4 change behind the full G1 contract suite before keeping it |
| Something unintended is committed | The tracked file list contains anything not in the module map | Content gate is a blocking step in Phase 6; the tracked list is short enough to read in full |

---

## 9. Companion documents

| File | Purpose |
| --- | --- |
| `01-ARCHITECTURE.md` | Target design, module map, schema, config surface |
| `02-TASKS.md` | Numbered task board with owners, dependencies, and done criteria |
| `03-AGENTS.md` | Agent roles, file ownership, prompt templates, house rules |
| `04-VERIFICATION-GATES.md` | Gates G0–G7 with exact commands and pass criteria |
| `05-BENCHMARK-PROTOCOL.md` | Rig, scenarios, drain harness, experiment queue |
| `06-SUBMISSION-CHECKLIST.md` | Definition of Done, hygiene, sanitisation gate, README outline |
