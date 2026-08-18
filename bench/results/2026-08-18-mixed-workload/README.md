# 2026-08-18 — mixed workload: reads during ingestion

Per-run index for the A/B that decided the runtime and framework adoption.
Narrative: `docs/test_results/mixed-workload-baseline.md`. Raw output (JSON,
resource CSVs, summaries) is in the private analysis repo under
`evidence/2026-08-18-mixed-workload/` — see `plan/internal/SANITIZATION.md` §7.

## What this set measures

The first measurement here of the **read path while writes are running**. Every
earlier read number in this repository — the whole Express/Fastify × Node/Bun
2×2, the page-latency targets, the 1.5M-row drain walk — was taken against a
**static table with no concurrent writers**, which is not a condition the
service ever operates in.

## Harness

`scripts/mixed-workload.mjs` (`npm run bench:mixed`). Two properties are
load-bearing and a replacement must keep them:

- **Open-loop ingest.** Batches are dispatched against a wall clock, not against
  completions. A closed-loop client (which `benchmark.mjs` is) sends less when
  the server slows, so offered load collapses to whatever the server can absorb
  and a backlog never forms — the effect being measured stays invisible.
  Requests the in-flight ceiling prevents are recorded as `shed_requests`.
- **Visibility measured under sustained load.** A reader catching up on a table
  nobody is writing to has the whole CPU to itself. Measured that way the
  Express build reported 100% visible; measured with writes still flowing it
  reports ~15%.

## Protocol

3 interleaved pairs, clean volume per run (`rows_before: 0`), one stack up at a
time, build verified inside the container on every run, 60 s load at a 15,000
logs/s target with batch 33, then a 30 s visibility window, 1,000-row pages.

Builds: `main` @ `ec09f9c` (Express + Node 22.18) against `perf/fastify-bun` @
`592e17a` (Fastify + Bun 1.3.14) — both since merged, so the shipped stack is
the `fastify+bun` column.

## Columns

| Column | Meaning |
| --- | --- |
| `drain_pages_s` | Cursor pages completed per second **while ingest runs** — the headline |
| `visible_pct` | Share of rows acknowledged before the window that a reader could find inside it |
| `limited_by` | `window` = ran out of clock still walking; `data` = reached the true end |
| `shed_requests` | Batches the client could not deliver at the offered rate |
| `pg_cpu_max` | PostgreSQL peaks above 100% are peaks above its own 1.0 CPU cap |

`limited_by` carries the finding: Express stops because the 30 s window expires
while it is still walking at about a page per second; Fastify + Bun stops
because it ran out of rows, having reached the end of a cohort nearly twice as
large with time to spare.

## Result

| | Express + Node | Fastify + Bun |
| --- | ---: | ---: |
| drain under load | 0.96–1.09 pages/s | **19.6–21.7** |
| page p95 | 802–897 ms | 86–90 ms |
| aggregate p95 | 617–2,318 ms | 86–217 ms |
| visible in 30 s | 14.5–15.3% | **99.6–99.8%** |
| ingest | 8,030–8,896 logs/s | 14,919–14,989 |
| api / postgres CPU avg | 46% / 28–33% | 45% / 72–76% |

Fastify + Bun wins all three pairs on every column. Within-side spread is
10–13%, against the ~6–11% session noise calibrated in `agents.md`; the drain
effect is ~19×.

## Validity and caveats

All six rows are `verified`: interleaved, three per side, clean volume, build
checked in-container, one stack at a time, zero errors.

- The Express runs shed 12,000–18,000 requests, so their **ingest** figure is
  partly a harness floor rather than purely a service limit. The Fastify + Bun
  runs shed none. This does not touch the drain, latency or visibility columns,
  which are the comparison.
- Nothing exceeds 60 s of load — no soak, no sustained-RSS figure.
- One host, one session.
- An earlier version of this A/B used a visibility metric that counted rows
  written *during* the walk against a frozen denominator and reported an
  impossible 100.1%. Those runs are kept in the private repo under
  `superseded-metric-v1/`; their drain, latency and CPU columns were unaffected
  and corroborate these (drain 18.86–21.94 pages/s there).
