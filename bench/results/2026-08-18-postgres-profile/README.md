# 2026-08-18 — PostgreSQL profile under mixed load

Narrative: `docs/test_results/postgres-profile.md`. Raw output in the private
analysis repo under `evidence/2026-08-18-postgres-profile/`.

## Why

Adopting Fastify + Bun moved the constraint off the application. Under Express +
Node the api was pinned at its 0.5-CPU cap while PostgreSQL idled at 28–33%;
under the shipped stack the api sits at ~45% and PostgreSQL carries 72–76% with
peaks over its own 1.0 cap. Nothing in this project had ever profiled the
database.

## Method

One `scripts/mixed-workload.mjs` run (60 s load at a 15,000 logs/s target, batch
33, plus a 30 s visibility window) on `main` @ `5dc962c`, with
`bench/raw/pgprof.override.yml` enabling `pg_stat_statements` and
`track_io_timing`. The override repeats the whole `command` list because compose
replaces list-valued keys rather than merging them — omitting the rest would
silently drop every tuning flag the shipped file sets and profile a different
database than the one that ships. `pg_stat_activity` was sampled at 4 Hz for
wait events. **This is a single run, not an A/B**; it apportions cost, it does
not compare configurations.

## Findings

- **71% of database time is writes.** `COPY` alone is 71.3%.
- **The rollup design is vindicated** — aggregates cost 0.2% because they read
  `logs_agg_1m` rather than raw rows.
- **173 MB of index took zero scans**: the `(service, level, timestamp, id)`
  index (116 MB) and the attribute GIN (57 MB). `EXPLAIN (ANALYZE, BUFFERS)`
  shows the page query served entirely by backward scans on each partition's
  primary key. Both are still maintained inside the `COPY` that owns 71% of
  database time.
- **PostgreSQL is CPU-bound, not IO-bound** — 3 wait samples on `DataFileRead`
  across the whole run at a 96.2% buffer hit ratio.
- **Backends do their own eviction** — `buffers_backend` 38,055 against the
  checkpointer's 919 and the bgwriter's 18,238.

## The caveat that matters

This workload's reads are an **unfiltered** cursor walk plus aggregates. It never
filters by `service`, by `level`, or by an attribute. The two unused indexes are
therefore **untested, not useless** — migration 002 records the GIN taking an
attribute lookup from ~158 ms to ~0.4 ms. What this establishes is that they are
pure write cost under the query mix every throughput and freshness number in
this repo comes from, which makes dropping them a trade to measure against a
service-filtered walk (`DRAIN_FILTERS=service=checkout`), not a cleanup.
