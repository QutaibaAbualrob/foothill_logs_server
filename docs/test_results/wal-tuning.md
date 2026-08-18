# WAL tuning: `max_wal_size` and `wal_buffers`

**Date:** 2026-08-18
**Build:** `perf/db-write-cost` at `c71949e` — Fastify on Bun 1.3.14, with
migration `004` (service index dropped)
**Harness:** `scripts/mixed-workload.mjs`, **120 s** at a 45,000 logs/s offer,
batch 200, plus a 30 s visibility window; clean volume per run
**Runs:** 12 (two items × 3 interleaved pairs), zero aborted, zero read errors
**Settings:** measurement-only overrides in `bench/raw/wal-*.override.yml`; the
shipped compose file is unchanged by these runs

## Result

| Item | Change | Verdict |
| --- | --- | --- |
| 4 | `max_wal_size` 2 GB → 8 GB | **Reject.** Only WAL volume moved, and it buys nothing |
| 5 | `wal_buffers` 8 MB → 16 MB | **Adopt, on qualified evidence.** Ingest p95 −16.6%; the real effect is variance collapse |

## Why these runs are 120 s, and why that matters

**Every previous run in this project was 60 s, and no 60 s run has ever
triggered a size-driven checkpoint.** The trigger distance is
`max_wal_size / (1 + checkpoint_completion_target)` = 2048 / 1.9 ≈ **1,078 MB**
of WAL, confirmed by observation at 1,064 MB and 1,076 MB. At the 15,000 logs/s
target the service writes ~8.3 MB/s of WAL, so 2 GB takes **247 s** to
accumulate.

This retires a claim `plan/08` inherited from the first profile: that
checkpoints were size-driven at ~3.5 minutes and were biting our runs. They were
not happening at all. The 16,141 full-page images seen in
`postgres-profile.md` came from startup and timed checkpoints, not from
size-driven cycling.

A 300 s run was attempted first and **exhausted the host disk** (3.64 GB of WAL,
6.37M rows). 120 s at a saturating offer crosses the threshold ~1.8 times and
fits the available space.

## These are saturated runs, not clean throughput numbers

At 120 s of sustained saturation the service **sheds ~34% of offered requests**:
6.75M logs offered, ~4.4M accepted, `rejected: 0`, and 11.0–13.0k failed
requests per run × 200 logs each — which exactly accounts for the gap. That is
the designed 503 backpressure refusing load rather than growing memory, and it
has never been observed before because no run was long enough to reach it.

Both sides of both A/Bs shed comparably, so the comparisons hold. But per the
measurement standard, **a cell with non-zero errors is not a throughput number**:
read the throughput columns below as "what the service absorbed while refusing
the rest", not as a capacity figure.

## Item 4 — `max_wal_size` 2 GB → 8 GB

The manipulation worked exactly as intended: **2 checkpoints per run at 2 GB, 1
per run at 8 GB** (the startup checkpoint only), consistent across all three
pairs.

| Metric | 2 GB (2 ckpt) | 8 GB (1 ckpt) | Δ | |
| --- | ---: | ---: | ---: | --- |
| **WAL bytes/row** | 586–597 | 548.2–548.4 | **−7.2%** | **separated** |
| Throughput | 27,951–30,110 /s | 28,803–29,975 | +0.8% | overlap |
| Ingest p95 | 1,894–2,418 ms | 1,956–2,067 | −3.0% | overlap |
| Ingest p99 | 2,250–3,508 ms | 2,802–3,276 | +4.1% | overlap |
| Drain | 11.7–12.9 pages/s | 9.8–14.4 | +2.6% | overlap |
| Aggregate p95 | 265–283 ms | 278–364 | +14.4% | overlap |
| PostgreSQL CPU | 69.1–74.1% | 67.5–75.5% | +1.6% | overlap |

**One metric moved and it does not convert.** The WAL reduction is real and has
a clean mechanism: the first write to a page after a checkpoint emits a
full-page image, so halving the checkpoint count removes one round of FPIs.

It buys nothing because **WAL bandwidth was never the constraint.**
`postgres-profile.md` established the database is CPU-bound — 96.2% heap buffer
hit ratio, three `DataFileRead` samples in an entire run. Writing 7% less WAL
does not help a workload that is not waiting on WAL.

One observation not separable at n=3, but worth recording: baseline aggregate
p99 swung 302 → 968 ms across runs. A single checkpoint in this set took
**74.7 s** to write, and that is the shape its cost takes when it lands in a
tail.

**Recommendation: leave `max_wal_size` at 2 GB.** A 4× configuration change that
moves one non-binding metric is not worth the additional WAL retention on a host
already at 93% disk.

## Item 5 — `wal_buffers` 8 MB → 16 MB

`max_wal_size` held at the shipped 2 GB on both sides, so this is one variable.
Both sides took 2 checkpoints per run.

| Metric | 8 MB | 16 MB | Δ | |
| --- | ---: | ---: | ---: | --- |
| **Ingest p95** | 1,691–2,363 ms | 1,606–1,683 | **−16.6%** | **separated** |
| Throughput | 27,406–34,216 /s | 33,775–34,094 | +10.8% | overlap |
| Ingest p99 | 1,960–2,783 ms | 2,046–2,134 | −15.1% | overlap |
| Drain | 11.9–13.3 pages/s | 11.7–14.7 | +3.8% | overlap |
| WAL bytes/row | 562–586 | 581–582 | +0.9% | overlap |
| PostgreSQL CPU | 67.9–78.0% | 77.1–77.5% | +5.4% | overlap |

**The effect is variance collapse, not a higher ceiling.** The spreads are the
finding:

| | 8 MB | 16 MB |
| --- | --- | --- |
| Throughput per run | 34,216 / 27,406 / 30,346 — **25% spread** | 33,775 / 34,094 / 34,054 — **0.9% spread** |
| Ingest p95 per run | 1,691 / 2,363 / 1,886 | 1,606 / 1,667 / 1,683 |
| Failed requests | 7,924 / 13,012 / 10,836 | 8,016 / 8,321 / 8,061 |

The baseline's **best** run (34,216 logs/s) matches the 16 MB runs. It is the bad
runs that differ. With 8 MB the run sometimes stalls contending for WAL buffers;
with 16 MB it consistently does not. WAL volume per row is unchanged, as
expected — `wal_buffers` changes how WAL is buffered before write, not how much
is produced.

**State the limit of this evidence plainly.** The p95 bands separate by only
0.5% (1,683 against 1,691), which is well inside the ~6% within-session noise,
and the separation depends on the baseline's worst run. No single number here is
convincing on its own. What supports adoption is that every indicator points the
same direction with nothing against it, the mechanism is coherent, and the cost
is one compose line plus 8 MB of a 1 GB container. **Confirming the variance
claim properly needs more than three repeats per side.**

**Recommendation: adopt `wal_buffers = 16MB`**, recorded as a stability change
rather than a throughput change.

## Validity and caveats

- 3 interleaved pairs per item, clean volume per run, build verified
  in-container every run, one stack up at a time, **zero read errors**, no
  aborted runs.
- Ingest errors are non-zero by design (saturating offer, 503 backpressure) —
  see the section above. Both sides comparable.
- **These runs are not comparable to any earlier set**: 120 s at a 45,000 /s
  offer against every prior run's 60 s at 15,000 /s.
- One host, one session. Host disk was at 93% throughout; a 300 s variant is not
  currently runnable.
- Item 5's throughput column overlaps only because of one outlying baseline run;
  the mean difference is +10.8% but should not be quoted as a throughput gain.
- Two guards fired during this work and both were correct: the disk guard
  stopped a campaign that would have run out of space, and the `wal_buffers`
  guard aborted a campaign built on a misreading of `pg_settings` (`setting`
  1024 with `unit` `8kB` renders as the string `10248kB`, which is 8 MB, not
  10 MB).

## CHANGES

- 2026-08-18: created. Items 4 and 5 of `plan/08-DATABASE-COST-REDUCTION.md`.
