# Benchmark results — foothill_logs_server

Recorded 2026-08-21. Tool: `@foothill/logs-benchmark` (github:Ahmad-Abbas-Foothill/logs-benchmark-cli), score version `2026-08-18.v10`.

## Machine

| | |
|---|---|
| OS | Ubuntu 24.04.4 LTS (Linux 7.0.0-29-generic, bare metal) |
| CPU | Intel Xeon E5-2667 v4 @ 3.20GHz — 8C/16T, Broadwell-EP (2016) |
| CPUs seen by Docker | 16 |
| Memory | 31.2 GiB |
| Docker / Compose | 29.7.2 / v5.3.1 |
| Resource limits enforced | True |
| Background load | Firefox + Claude Desktop running; load avg ~1.2/16 |

**Not a clean room.** The guidance says to close everything else; the Claude Desktop app could not be closed because it hosted the session.

## Baseline — `--generator-cpus 4`

| Category | run1 | run2 | run3 | mean | spread |
|---|---|---|---|---|---|
| **Total /100** | 96.11 | 94.88 | 96.04 | 95.68 | 1.23 |
| Correctness /15 | 15.00 | 15.00 | 15.00 | 15.00 | 0.00 |
| Performance /50 | 46.47 | 45.80 | 46.49 | 46.25 | 0.69 |
| Queries /15 | 14.64 | 14.08 | 14.55 | 14.42 | 0.56 |
| Reliability /20 | 20.00 | 20.00 | 20.00 | 20.00 | 0.00 |
| machine speed | 0.1352 | 0.1202 | 0.1220 | 0.1258 | 0.0150 |

Dropped iterations (k6 could not start — generator-limited):

| scenario | run1 | run2 | run3 |
|---|---|---|---|
| stress | 422 | 319 | 113 |
| spike | 116 | 250 | 48 |
| breakpoint | 514 | 605 | 562 |

## Follow-up — `--generator-cpus 6`

| Category | g6run1 | g6run2 | g6run3 | mean | spread |
|---|---|---|---|---|---|
| **Total /100** | 94.93 | 94.67 | 94.73 | 94.78 | 0.26 |
| Correctness /15 | 15.00 | 15.00 | 15.00 | 15.00 | 0.00 |
| Performance /50 | 45.59 | 45.64 | 45.89 | 45.71 | 0.29 |
| Queries /15 | 14.33 | 14.03 | 13.85 | 14.07 | 0.49 |
| Reliability /20 | 20.00 | 20.00 | 20.00 | 20.00 | 0.00 |
| machine speed | 0.1248 | 0.1233 | 0.1184 | 0.1222 | 0.0064 |

Dropped iterations (k6 could not start — generator-limited):

| scenario | g6run1 | g6run2 | g6run3 |
|---|---|---|---|
| stress | 390 | 675 | 402 |
| spike | 43 | 142 | 165 |
| breakpoint | 493 | 636 | 504 |

## Verdict

- Correctness **15/15 in all six runs**, zero variance, no cap applied, `eligible: true`.
- Baseline mean **95.68**, 6-CPU mean **94.78** — raising `--generator-cpus` cost 0.90 points and did not clear the warning. **Keep the flag at 4.**
- `generatorLimited: true` / `serviceLimited: false` on stress, spike and breakpoint in every run: Performance and Queries are floors, not ceilings.
- Throughput is deterministic (`load` = 14,999.167/s to the decimal in all runs); the variance lives entirely in latency tails.
