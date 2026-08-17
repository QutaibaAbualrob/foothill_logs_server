# Express vs Fastify — measured runs, 2026-08-17

`runs.csv` indexes every benchmark run taken on 2026-08-17: 59 rows, one per
run, measured on native Linux under the shipped caps (api 0.5 CPU / 256 MB,
postgres 1.0 CPU / 1 GB).

The narrative write-ups are `docs/test_results/batch33-and-cpu-profile.md` and
`docs/test_results/fastify-branch-results.md`.

## Headline

| | Express (`main`) | Fastify (`perf/fastify-node`) |
| --- | ---: | ---: |
| Ingest, batch 200 | 13,916 logs/s | **14,980 logs/s** (+7.7%) |
| Aggregate p95 during ingestion | 631 ms | **554 ms** |
| Paired runs won | 0 of 8 | **8 of 8** |

Batch 33 on `main` is 8,169.8 logs/s with the application container at 47.9% of
its 50% cap — the application is the constraint there, not PostgreSQL.

## Reading the CSV

The `validity` column is load-bearing. Not all 59 rows are comparable:

| validity | rows | use |
| --- | ---: | --- |
| `verified` | 6 | The container was asked which framework it had before each run. **Use these for any claim.** |
| `relabelled` | 14 | Sound data, but the **filename's branch label is inverted**. The `framework` column is corrected; trust it over the filename. |
| `valid-single-session` | 9 | Express baseline and profiling runs. Valid alone, not comparable across sessions. |
| `void-as-comparison` | 10 | Both sides of these pairs were Fastify. Useless as a comparison. |
| `historical` | 20 | Earlier sessions, different day and database state. |

## Two traps, recorded so they are not repeated

1. **This host drifts by tens of percent between sessions.** A `main` run
   measured 8,170 logs/s in the morning and 10,532 in the afternoon. Any A/B
   compared across sessions is worthless here: interleave the branches, repeat
   at least three times, use a clean volume per run, report the spread.

2. **A branch name is not proof of what is running.** A commit intended for a
   branch landed on `main`, which inverted an entire A/B and produced a
   confident, exactly backwards conclusion before it was caught. Verify from
   inside the container:

   ```bash
   docker compose exec -T api sh -c 'ls node_modules | grep -xE "fastify|express"'
   ```

## What is not here

The raw harness output (90 files: result JSONs, resource CSVs, the `--trace-gc`
log) and the three V8 CPU profiles of the ingest path are **deliberately not in
this repository**. They live only in the private analysis repository — location
and rules in `plan/internal/SANITIZATION.md` §7 — because the profiles contain
the service's full call tree and internal paths, and because 1.6 MB of
artifacts does not belong in a public tree.

They are not reproducible from this repo after the fact: the harnesses write to
`bench/raw/`, which is gitignored. **If you take new measurements, commit and
push them to the private repository in the same session, or they are lost.**
