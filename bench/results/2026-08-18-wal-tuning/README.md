# 2026-08-18 — WAL tuning: `max_wal_size` and `wal_buffers`

Per-run index for items 4 and 5 of `plan/08-DATABASE-COST-REDUCTION.md`.
Narrative: `docs/test_results/wal-tuning.md`. Raw output is in the private
analysis repo under `evidence/2026-08-18-wal-tuning/` — see
`plan/internal/SANITIZATION.md` §7.

## Outcome

| Item | Change | Verdict |
| --- | --- | --- |
| 4 | `max_wal_size` 2 GB → 8 GB | **Rejected** — only WAL volume moved (−7.2%/row) and it converts to nothing |
| 5 | `wal_buffers` 8 MB → 16 MB | **Adopted** — ingest p95 −16.6%; the real effect is variance collapse |

## These runs are unlike every earlier set here

Two differences that make cross-set comparison invalid:

- **120 s of load, not 60 s.** These are the first runs over 60 seconds in the
  project. They exist because **a 60 s run never triggers a size-driven
  checkpoint** — the trigger distance is ~1,078 MB of WAL and 60 s at the
  15,000 /s target produces ~500 MB. Item 4 was unmeasurable at the standard
  run length.
- **A 45,000 logs/s offer, deliberately above capacity.** The service therefore
  **sheds ~34% of offered requests** (`failed_requests` ≈ 11–13k per run ×
  200 logs each, `rejected: 0`). That is the designed 503 backpressure, first
  observed here because no earlier run was long enough to reach it.

Both sides of both A/Bs shed comparably, so the comparisons hold — but per the
measurement standard a cell with non-zero errors is **not a throughput number**.
Read `logs_s` as "absorbed while refusing the rest".

## Columns

| Column | Meaning |
| --- | --- |
| `variant` | The actual setting in effect, verified from inside the server every run |
| `checkpoints` | Completed checkpoints in the run — **the manipulation for item 4** (2 at 2 GB, 1 at 8 GB) |
| `wal_bytes_per_row` | Use this rather than absolute WAL; the sides accept different row counts |
| `failed_requests` | 503 backpressure, not defects. `rejected` (validation failures) is 0 throughout |
| `pg_cpu_max` | Values above 100 are peaks above PostgreSQL's own 1.0 CPU cap |

## Reading item 5 correctly

The means understate what happened. The **spreads** are the finding:

| | 8 MB | 16 MB |
| --- | --- | --- |
| Throughput | 34,216 / 27,406 / 30,346 — 25% spread | 33,775 / 34,094 / 34,054 — 0.9% |
| Ingest p95 | 1,691 / 2,363 / 1,886 ms | 1,606 / 1,667 / 1,683 |
| Failed requests | 7,924 / 13,012 / 10,836 | 8,016 / 8,321 / 8,061 |

The 8 MB **best** run matches 16 MB. It is the bad runs that differ — the run
intermittently stalls contending for WAL buffers at 8 MB. `wal_bytes_per_row` is
unchanged, as expected: `wal_buffers` changes buffering, not WAL volume.

**The evidence is qualified.** The p95 bands separate by 0.5% (1,683 vs 1,691),
inside the ~6% session noise, and the separation rests on the baseline's worst
run. Adoption is justified by every indicator agreeing, a coherent mechanism,
and a cost of one compose line plus 8 MB of a 1 GB container — not by any single
number. Confirming the variance claim needs more than three repeats per side.

## Validity and caveats

- 3 interleaved pairs per item, clean volume per run, build and setting verified
  in-container every run, one stack at a time, **zero read errors**, zero
  aborted runs.
- One host, one session. Host disk at 93% throughout; a 300 s variant was
  attempted first and **exhausted the disk** (3.64 GB WAL, 6.37M rows).
- Item 4's aggregate p99 on the baseline swung 302 → 968 ms. One checkpoint in
  this set took 74.7 s to write. Not separable at n=3, but it is the shape of
  the cost.
- Item 5's `pg_cpu_avg` is higher on the adopted side (77.1–77.5 vs 67.9–78.0),
  overlapping — consistent with the 16 MB runs simply doing more work per run
  rather than with a regression.
