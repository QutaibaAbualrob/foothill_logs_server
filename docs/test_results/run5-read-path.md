# Run 5: the read-path bundle on the platform

**Date:** 2026-08-20
**Build:** `main @ 056a74e` — query pool 2, read statement timeout 8 s, and the
aggregate answered in one round trip
**Baseline:** `main @ 1634a98` (run 4)
**Measured by:** the platform, one submission each. Local runs cannot see any of
this — see "Why the local harness is blind to this" below.

## Result

**40.56 / 100**, from 39.49. Correctness 15/15 and Reliability 20/20 unchanged.

| Metric (load scenario) | run 4 | run 5 | |
| --- | ---: | ---: | --- |
| **ingestion latency p95** | 2,073 ms | **65 ms** | **31.7x faster** |
| request latency p95 | 4,111 ms | 2,078 ms | 2.0x |
| aggregate p95 | 4,595 ms | 2,170 ms | 2.1x |
| accepted throughput | 3,368 /s | 4,169 /s | +24% |
| HTTP error rate | 20.90% | **27.48%** | **worse** |
| PostgreSQL CPU, average | 75.60% | 78.21% | rose |
| application CPU, average | 5.42% | 7.76% | rose |

The ingestion collapse is the headline and it is real. Everything else in this
file exists to stop that number being read as more than it is.

## The entire +1.07 is throughput

Performance is four weighted components taken from the load scenario:

```
throughput = clamp(logsPerSecond / 15000)            x 0.40
errors     = clamp(1 - (errorRate - 0.002) / 0.028)  x 0.30
latency    = clamp(1 - (p95Ms - 100) / 900)          x 0.20
bonus      = +0.05 at 19,800 /s sustained, +0.10 at 24,750 /s
```

Run 5: `0.4 x (4169.17/15000) x 50 = 5.559`, which reproduces the reported 5.56
exactly. **Errors and latency both clamp to zero**, and Queries scores zero the
same way — `9 x clamp(1 - aggregateP95/500)` is zero above 500 ms.

Distance to each cliff, which is the only measure of progress that matters here:

| bucket | worth | needs | run 4 | run 5 |
| --- | ---: | --- | ---: | ---: |
| throughput | 20 | 15,000 /s | 4.49 pts | 5.56 pts |
| errors | 15 | < 3% | 6.97x over | **9.16x over** |
| request latency | 10 | < 1,000 ms | 4.11x over | 2.08x over |
| aggregate | 9 | < 500 ms | 9.18x over | 4.34x over |

Two cliffs came a long way closer. **The error cliff moved further away.**

## Attribution was deliberately spent

Three changes shipped in one submission because platform submissions are the
only instrument that can measure them and they are scarce. That was the right
trade, and the price is that **the 31.7x ingestion improvement belongs to the
bundle, not to any one change**. Cutting the read pool frees database CPU for
writers; so does removing two of every three read statements. Both are
plausible, neither is separable, and no file should claim otherwise.

## The request mix is exactly 1 POST + 2 GETs

`http_requests / (accepted_logs / 100)` is **3.0000 in all eight scenario-runs**
across runs 4 and 5. The load generator issues one ingest POST and two reads per
iteration, unsampled.

This is derived from the platform's own reported counts with no assumption about
the generator's internals, which is what makes it safe to rely on. It gives the
decomposition directly:

```
load, run 5:  500,300 accepted / 100          =  5,003 POSTs
              15,010 requests - 5,003         = 10,007 GETs
              27.48% x 15,010                 =  4,125 failures
              POST success rate 100.00%       => every failure is a GET
                                              => 41.2% of GETs fail
```

**Reads outnumber writes two to one, and two in five of them fail.** Since POST
success is exactly 100%, `GET failure rate = error rate x 1.5` throughout.

## Reads do not fail because the aggregate is slow

The obvious reading — reads fail because aggregates are slow, so a faster
aggregate fixes the error rate — is **contradicted by our own data**:

| scenario | aggregate p95, run 4 -> 5 | GET failure, run 4 -> 5 |
| --- | --- | --- |
| load | 4,595 -> 2,170 ms | 31.4% -> 41.2% |
| **spike** | **4,398 -> 2,104 ms** | **8.69% -> 8.67%** |

**Spike halved its aggregate latency and its GET failure rate did not move**, to
two decimal places. On the three high-rate scenarios failure rose while
aggregate latency fell.

What GET failure tracks is **offered load**. Spike offers 7,500 logs/s for 90 of
its 100 seconds and is flat across both runs; load, stress and breakpoint all
push 15,000 /s or more and all worsened. The working hypothesis is therefore
connection contention rather than query cost: the read pool went from 8 to 2, so
fewer reads can be in flight, and at high offered load the arrival rate exceeds
what two connections retire.

**That hypothesis is untested.** It is recorded here as the next thing to
measure, not as a conclusion.

## What the load generator's own limits imply

The ingest executor's virtual-user pool is
`max(preAllocatedVUs, min(800, ceil(peakIterationRate x thresholdP95Ms / 1000 x 1.5)))`
with `preAllocatedVUs = max(10, firstStageIterationRate)`:

| scenario | preAlloc | latency-derived | pool | binding term |
| --- | ---: | ---: | ---: | --- |
| load | 150 | 113 | **150** | preAlloc |
| stress | 150 | 450 | 450 | latency |
| spike | 75 | 900 | 800 | the 800 cap |
| breakpoint | 150 | 2,025 | 800 | the 800 cap |

**For the load scenario the latency term is discarded**, so cutting request
latency does not widen the generator's offer there. It does in stress. An
earlier draft of this analysis claimed latency gated throughput on load; that
was wrong, and it is recorded here so the claim is not revived.

Per-scenario pass thresholds: load `1% / 500 ms`, stress `5% / 1,000 ms`, spike
`10% / 2,000 ms`, breakpoint `20% / 3,000 ms`.

## Why the local harness is blind to this

The local database is idle: aggregate p95 there is 41-58 ms across four runs, so
there is nothing for a read to queue behind and no contention to remove. The
same commit measured locally scores 95.598 against a 94.933-95.787 baseline band
— inside the noise, second-best of four on score, aggregate p95 and request p95
alike. **The local run is a regression gate and nothing more.** It correctly
showed no harm; it could not have shown the 31.7x.

## Validity and caveats

- One submission per build. No repeats, so none of these deltas has an error bar
  and the measurement standard's three-repeat rule is **not** met. Treat single
  platform runs as directional.
- Three variables moved at once, by choice. See "Attribution was deliberately
  spent".
- The generator constants and thresholds above come from the local benchmark
  CLI, which reports itself as `phase-7-performance-v2`. The platform ran
  **`performance-v4`**. Metric names match exactly, but the local script cannot
  reproduce the observed 3.0000 request ratio, so **the two scripts differ**.
  Anything in this file derived from the local script carries that bound; the
  3.0000 ratio and every scored number do not, being platform-reported.
- `postgres_cpu` rose slightly (75.60 -> 78.21) rather than staying flat.

## What this leaves

Ingestion is no longer the constraint at 65 ms. Every unscored point now sits
behind reads: the aggregate cliff at 500 ms, the error cliff at 3%, and the
request-latency cliff at 1,000 ms which is essentially the aggregate's own
number. The next change is an in-process aggregate so the endpoint stops
consuming a database connection at all — which tests the contention hypothesis
above directly, and is the only remaining lever on the aggregate cliff.

## CHANGES

- 2026-08-20: created. Run 5 (`056a74e`) against run 4 (`1634a98`).
