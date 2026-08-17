# Benchmark Protocol

No optimisation without a baseline. No claim without a script. One variable per
experiment.

Derived from `search_rnd/RND.md` §9.5 and §12, which set the measurement rules
this project follows.

---

## 1. Rules

1. **Never hardcode a time range.** Derive `since`/`until` from the data actually
   present. A stale hardcoded window silently measures an empty range and
   reports a meaningless few-millisecond latency.
2. **The shipped script drives the batch size the README reports.** If the
   README says 50 logs per request, the script sends 50.
3. **The generator includes backdated timestamps.** A generator that only sends
   "now" never exercises the partition window or the retention path.
4. **Report p50, p95, p99** — never an average alone. Thresholds are
   latency-shaped, and checkpoint, GC, lock, and I/O pauses live in the tail.
5. **One variable per run.** Change one thing, re-measure, record, decide.
6. **Clean database between comparable runs**, or say explicitly that the run was
   warm.
7. **One benchmark at a time on one machine.** Two concurrent runs invalidate
   both.
8. **Record losing results.** An experiment that made things worse is evidence
   and belongs in the log.

---

## 2. Rig

k6 runs from the `grafana/k6` image, attached to the compose network, so the
capped containers are the bottleneck rather than the harness.

```bash
docker compose up -d --wait
docker run --rm --network <project>_default \
  -v "$PWD/load:/load" -v "$PWD/bench/raw:/out" \
  grafana/k6 run --summary-export=/out/<run>.json /load/<scenario>.js
```

Sampled in parallel for both containers: CPU, RSS, and — for PostgreSQL — WAL
growth, table and index sizes, buffer hit ratio, temporary-file bytes, and
`pg_stat_activity` wait events, written to `bench/raw/<run>-resources.csv`.
Raw paths are create-only: every run uses a new name, and a collision is a hard
failure rather than an append or overwrite. The resource summary records its
actual start/end times and sample-cycle count.

### Scenarios

| Name | Shape | Purpose |
| --- | --- | --- |
| `load` | constant 15,000 logs/s for 120 s | the specification's baseline requirement |
| `stress` | 15,000 → 22,500 ramp | behaviour above the requirement |
| `spike` | 7,500 → 30,000 → 7,500 | recovery from a burst |
| `breakpoint` | 15,000 → 45,000 ramp | where it actually breaks, and how |

All scenarios: a warm-up, health polling before start, mixed valid/invalid
entries, mixed services and levels, a proportion of backdated timestamps, and a
concurrent read workload of at least one aggregate request per second plus
read-after-write probes — because the specification requires queries to stay
usable *during* ingestion (§24), so measuring ingestion alone measures the wrong
thing.

**Probe at ingestion rate, not on a timer.** A read-after-write probe issued
after *every* accepted `POST` is the shape a client that confirms its own writes
produces, and it is the only rate that exposes the interaction between the read
and write paths. Sampling visibility every few seconds instead looks like a
reasonable economy and is not: it under-represents attribute-query pressure by
orders of magnitude, and it hides three effects this project measured only after
switching to per-`POST` probing — a GIN pending list that every read must scan,
the `limit + 1` probe's full scan on a hit, and read queries starving the writer
for the single PostgreSQL CPU. An ingest-only or sparsely-probed number will
make almost any write-path change look better than it is.

### Load-generator payload shape

Fix these and keep them fixed, so results stay comparable:

- batch size per request (swept once in E4, then frozen and reported);
- ~5 services, 4 levels, message lengths in a realistic spread;
- 3–6 attributes per entry, mixing string, number, and boolean values — the
  number and boolean values are not decoration, they are what exercises the
  multi-type containment terms in the attribute predicate;
- a fraction of entries carrying a unique high-selectivity correlation key,
  queried back per the probing rule above; this is what exercises both the
  attribute GIN index and the hot-attribute index;
- a small fraction of deliberately invalid entries, to keep the partial-
  acceptance path on the hot path where it belongs.

---

## 3. The drain harness — the project's key measurement

This measures what `00-MASTER-PLAN.md` §3 identifies as the deciding constraint:
how fast a sequential cursor walk can traverse everything that was accepted.

```text
after a scenario ends:
  t0 = now
  cursor = none
  loop until deadline:
      GET /logs?limit=<page>&<filters>   (+cursor when present)
      record: per-page latency, rows returned, cumulative rows
      stop when next_cursor is null
  report: pages/s, rows/s, per-page p50/p95/p99,
          total rows reached, reached-true-end (bool),
          unique-id count vs trusted SELECT count(*)
```

Emitted per run into `bench/results/drain-<scenario>.md`:

| Field | Why it matters |
| --- | --- |
| pages/second | the number the whole optimisation campaign moves |
| rows/second | pages/s × page size; the throughput of the read path |
| per-page p95 | the budget is ≤8 ms for a 1,000-row page |
| reached true end | correctness — did the walk finish, or stop early |
| unique ids vs trusted count | proves no row was skipped or repeated |
| time to completion | against the drain window |

**Diagnostic rule:** if the rows reached is roughly constant across runs with
different accepted volumes, the walk is terminating early — that is a cursor
correctness bug, not a speed problem. Go to gate G3 before touching performance.

---

## 4. Experiment queue

Run in this order. Record every row, including regressions.

| # | Experiment | Variable | Decide on |
| --- | --- | --- | --- |
| E0 | Baseline | none — defaults | all metrics, as the reference |
| E1 | Row-to-JSON construction site | driver objects+stringify / PostgreSQL per-row JSON / PostgreSQL whole array | page p95, application CPU, PostgreSQL CPU, RSS |
| E2 | Direct response write | framework serialiser vs prepared buffer | page p95, application CPU |
| E3 | Bounded read-ahead | `READAHEAD_PAGES` 0 / 1 / 2 | drain pages/s, RSS ceiling, G1 still green |
| E4 | Batch shape | ~~target rows, byte budget~~, idle delay, write concurrency | sustained throughput **and** PostgreSQL CPU headroom |
| E5 | Pool layout | reserved split vs larger shared | completed drain **and** accepted throughput together |
| E6 | Bulk mechanism | COPY vs UNNEST INSERT | throughput, p95, CPU, memory |
| E7 | Durability profile | `SYNC_COMMIT` off / on | throughput and p95, reported per profile |
| E8 | Hot-attribute index | present / absent | probe latency gain vs measured ingestion cost |
| E9 | Optional attribute GIN | present / absent | `attr.*` query gain vs write amplification — **expectation was wrong, see below** |
| E10 | Retention under load | idle / active during ingestion | throughput dip, lock waits, stale aggregates |
| E11 | GIN `fastupdate` | on / off | mixed-workload throughput, **not** ingest-only throughput |

**E4 is narrower than it was.** A flush now takes the whole queue, so there is
no target-row or byte budget to sweep: those knobs were removed after capping a
flush below the waiting backlog proved to be the dominant throughput limit. The
idle coalescing delay and write concurrency remain.

**E9's stated expectation was wrong, and the way it was wrong is the lesson.**
The prediction that a general attribute GIN would lose came from reasoning about
write amplification without measuring either side. Both halves were off: the
write cost was ~4.5% of throughput rather than prohibitive, and the read side
was far more expensive than "a scan on a rare filter" implies, because the
`limit + 1` page probe pays a full scan on a **hit** as well as a miss. Do not
carry an "expected to lose" into the result table; run the row.

**E11 exists because E9 alone would have measured the wrong thing.** A GIN
index's `fastupdate` pending list is nearly free on an ingest-only benchmark and
expensive on a mixed one, since every read scans the pending list. Measured
ingest-only, `fastupdate = on` looks fine; measured with reads, it cost more
than half the achievable throughput. Any GIN experiment must be run under the
mixed workload below.

### Result table format

Keep one table in `bench/results/experiments.md`. Every row is one run.

```text
| # | change | logs/s | ingest p95 | page p95 | drain pages/s | drain complete | app CPU | pg CPU | RSS | verdict |
```

`verdict` is `keep`, `revert`, or `inconclusive — needs a rerun`. An
`inconclusive` that is never rerun is reported as inconclusive in the README.

---

## 5. `EXPLAIN` captures

Into `docs/explain/`, one file each, taken at ≥1 M rows with the shipped
configuration:

| File | Query |
| --- | --- |
| `page-unfiltered.txt` | first page, no filters |
| `page-cursor.txt` | a mid-walk page with a cursor predicate |
| `page-service.txt` | `service` + `level` filtered page |
| `page-hot-attr.txt` | hot-attribute-key page |
| `page-attr-generic.txt` | arbitrary `attr.<key>` page (no dedicated index) |
| `aggregate-rollup.txt` | rollup path, grouped |
| `aggregate-raw.txt` | raw fallback path with `q` |
| `retention-drop.txt` | partition drop plus boundary sweep |

Each capture uses `EXPLAIN (ANALYZE, BUFFERS)`. For every capture, the README
records: which index was chosen, whether a sort node appears, buffer hit versus
read counts, and actual versus estimated rows. An index that no captured plan
uses is removed before the final push.

---

## 6. What the README reports

From `bench/results/final.md` only, and nothing else:

- test environment (host, CPU, RAM, Docker version, container caps);
- dataset size and time span; batch size; offered rate;
- ingestion throughput sustained, with the observed rate over time;
- ingestion p50/p95/p99; HTTP error rate; rejected count;
- aggregate p95 during active ingestion, and the query rate driven;
- cursor page latency and drain throughput;
- read-after-write freshness delay distribution;
- application and PostgreSQL CPU and memory, peak and average;
- WAL growth, table and index sizes, buffer hit ratio;
- bottlenecks found, and the optimisation that addressed each;
- both durability profiles, labelled;
- **anything that missed its target, with the number.**
