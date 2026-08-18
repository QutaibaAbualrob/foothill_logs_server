# PostgreSQL profile under mixed load

**Date:** 2026-08-18
**Build:** `main` at `5dc962c` — Fastify on Bun 1.3.14, the shipped stack
**Workload:** `scripts/mixed-workload.mjs`, 60 s at a 15,000 logs/s target, batch 33,
plus a 30 s visibility window; clean volume
**Instrumentation:** `bench/raw/pgprof.override.yml` — `pg_stat_statements`,
`track_io_timing=on`. Measurement-only; the shipped compose file is unchanged.

## Why

Adopting Fastify + Bun moved the constraint. Under Express + Node the application
was pinned at its 0.5-CPU cap while PostgreSQL idled at 28–33%; under the shipped
stack the api sits at ~45% and **PostgreSQL carries 72–76% with peaks over its own
1.0 cap**. Nothing in this project had ever profiled the database.

## Where database time goes

| Statement | Total | Calls | Mean | Share |
| --- | ---: | ---: | ---: | ---: |
| `COPY logs (...) FROM STDIN` | 61,647 ms | 1,778 | 34.67 ms | **71.3%** |
| Page query (cursor walk) | 16,375 ms | 2,210 | 7.41 ms | 18.9% |
| Page query, second form | 7,998 ms | 898 | 8.91 ms | 9.3% |
| `INSERT INTO logs_agg_1m … ON CONFLICT` | 184 ms | 1,778 | 0.10 ms | 0.2% |
| `SET LOCAL synchronous_commit = off` | 12 ms | 1,778 | 0.01 ms | 0.0% |

**Writes are ~71% of database time, reads ~28%.** (A further 0.2% is the
wait-event sampler this profile itself ran — noted so it is not mistaken for
application load.)

Two things this settles:

- **The rollup design pays for itself.** Aggregate queries cost 0.2% of database
  time because they read `logs_agg_1m` rather than raw rows — 7,005 index scans
  on its primary key. The write-side maintenance is likewise 0.10 ms per batch.
- **The read path is not doing anything pathological.** 7.4–8.9 ms per 1,000-row
  page, 96.2% heap buffer hit ratio (222,895 hits against 8,908 reads).

## The finding: 173 MB of index maintained for zero scans

| Index | Size | Scans in this run |
| --- | ---: | ---: |
| `logs_2026_08_service_level_timestamp_id_idx` | **116 MB** | **0** |
| `logs_2026_08_attributes_idx` (GIN) | **57 MB** | **0** |
| `logs_2026_08_pkey` | 40 MB | 5,095 |

`EXPLAIN (ANALYZE, BUFFERS)` on the page query confirms it: a `Merge Append` of
**backward index scans on each partition's primary key**, 38 buffers hit, 0.57 ms
for 1,000 rows. The `(service, level, timestamp DESC, id DESC)` index is never
consulted, and neither is the attribute GIN.

Both are still maintained on every inserted row, inside the `COPY` that owns 71%
of database time.

**State the limit of this plainly:** this workload's reads are an *unfiltered*
cursor walk plus aggregates. It never filters by `service`, by `level`, or by an
attribute. So these indexes are not shown to be useless — they are shown to be
**pure write cost under this query mix**, which is also the mix the throughput and
freshness numbers come from. A workload that filters by service would use the
first; one that filters by attribute would use the second, and migration 002
records that the GIN took an attribute lookup from ~158 ms to ~0.4 ms.

That makes the index question an explicit trade to be measured, not a cleanup:
drop or narrow them and the write path gets cheaper in the component that is now
the constraint, at the cost of the filtered read paths.

## Where the write cost actually is

| Signal | Value |
| --- | ---: |
| WAL generated | **859 MB** (8,170,369 records, 16,141 full-page images) |
| `COPY` block writes | 64,314 blocks, 1,013 ms write time |
| `buffers_backend` | **38,055** |
| `buffers_checkpoint` | 919 |
| `buffers_clean` (bgwriter) | 18,238 |
| Rows inserted | 1,349,964 into `logs_2026_08` |

Two observations:

- **~9.5 MB/s of WAL** for ~15,000 rows/s, with `synchronous_commit=off` already
  set. WAL volume is a direct consequence of row width and index count — the two
  unused indexes above are part of it.
- **Backends are doing their own eviction.** `buffers_backend` (38,055) dwarfs
  both the checkpointer (919) and the bgwriter (18,238), which means writer
  processes are stalling to find clean buffers instead of the background writer
  staying ahead of them. `bgwriter_lru_maxpages` / `bgwriter_delay` are untouched
  defaults and have never been measured here.

## It is CPU, not IO

Wait-event sampling of `pg_stat_activity` at 4 Hz for the whole run, counting only
non-idle backends:

| Wait | Samples |
| --- | ---: |
| CPU (running) | 186 |
| `Client / ClientRead` | 50 |
| `IO / DataFileRead` | 3 |

PostgreSQL is **on CPU**, not blocked on storage — three samples of data-file read
across the entire run, against a 96.2% buffer hit ratio. So the way to reduce its
cost is to give it less work (fewer index updates, less WAL, narrower rows), not
faster disks or more shared buffers.

## Next

1. **Measure dropping `logs_service_level_page_idx`** under this harness — both
   halves: the write gain at batch 33 and 200, and the read cost with a
   *service-filtered* walk (`DRAIN_FILTERS=service=checkout`), which this profile
   deliberately did not exercise.
2. **Same question for the attribute GIN**, which is 57 MB for zero scans here but
   is the difference between 0.4 ms and 158 ms on an attribute lookup.
3. **Tune the background writer.** `buffers_backend` at 41× the checkpointer is
   the clearest untouched signal in this profile.
4. **Attribute-filtered walks still have no coverage at all** — `HOT_ATTRIBUTE_KEYS`
   is empty in the shipped compose file, so the ordered partial-index path has
   never been exercised in any run.

## CHANGES

- 2026-08-18: created. First profile of the database, taken after Fastify + Bun
  moved the constraint off the application.
