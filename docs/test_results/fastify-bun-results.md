# Fastify + Bun — the fourth cell

**Branch:** `perf/fastify-bun` at `d212f1d` (cherry-pick of `68766fe` onto
`perf/bun-runtime` at `a5a00bb`, plus a regenerated `bun.lock`)
**Baseline:** `perf/bun-runtime` at `a5a00bb` (Bun + Express)
**Date:** 2026-08-17

**Verdict: Fastify adds ~9% on Bun at batch 33 and nothing at batch 200.** All
gates green. Whether that is worth the merge is the owner's call.

---

## 1. It runs, and it is correct

Fastify on Bun was not a given. It is:

| Gate | Result |
| --- | --- |
| `npm run smoke` (G1) | Pass |
| `npm run reliability` (G2) | **73 checks, 0 failures** |
| `npm run drill` | **PASS** — all endpoints 503 + `Retry-After`, 0 restarts, SIGTERM exit 0, `db +404600 = accepted 404600` |
| Test suite, Node/tsx runner | **32/32**, 0 skipped, integration tests executing |
| Test suite, Bun's own runner | **64 pass, 0 fail** across 12 files |

Proof of the stack under test, taken inside the container before every run:
`bun run src/index.ts`, Bun `1.3.14`, `fastify` in `node_modules`, caps
`500000000` / `268435456`.

Two integration notes for anyone repeating this:

- `docker-compose.bun.yml` is an **overlay**, not a standalone file. Used alone
  the project has no `postgres` service and the app retries `127.0.0.1:5432`
  forever. Compose it as `docker-compose.yml:docker-compose.bun.yml`.
- The cherry-pick carries `package.json` but not a matching `bun.lock`. The Bun
  image installs with `--frozen-lockfile`, so the lockfile must be regenerated
  or the build fails.

## 2. Batch 33 — Fastify earns its place

Three interleaved pairs, clean volume per run (`rows_before` = 0 every time),
build verified in-container, no other containers running, 60 s at concurrency 96.

| Run | Bun + Express | Bun + Fastify | delta |
| --- | ---: | ---: | ---: |
| 1 | 18,833.4 | 19,880.0 | +5.6% |
| 2 | 18,662.1 | 20,020.0 | +7.3% |
| 3 | 17,587.1 | 20,383.5 | +15.9% |
| **mean** | **18,361** | **20,095** | **+9.4%** |

Fastify wins all three pairs. Spread is 7.1% (Express) and 2.5% (Fastify).
0 errors throughout.

**Aggregate p95 is roughly halved**: 106–160 ms on Express against 73–83 ms on
Fastify.

This cell is **application-limited and therefore a valid framework comparison**:
the api container is pinned at its cap on both sides (48.7–49.1% of a 50%
ceiling), with PostgreSQL at 66–70% average.

## 3. Batch 200 — Fastify adds nothing

Same protocol.

| Run | Bun + Express | Bun + Fastify | delta |
| --- | ---: | ---: | ---: |
| 1 | 30,472.1 | 29,184.8 | −4.2% |
| 2 | 28,363.8 | 29,942.5 | +5.6% |
| 3 | 28,978.7 | 28,228.3 | −2.6% |
| **mean** | **29,272** | **29,119** | **−0.5%** |

The signs alternate and the difference is far inside the spread (7.4% and 6.1%).
This is a null result, not a small negative one.

**The reason is visible in the CPU columns.** The api container runs at
35.4–41.1% of its 50% cap — it is *not* the constraint — while PostgreSQL sits
at 68–73% average with peaks of 85–101%. **This cell is database-limited.** It
measures PostgreSQL, and no HTTP-layer change can move it.

## 4. The 2×2, complete

Throughput in logs/s, all cells measured to the seven-requirement standard.

**Batch 33** — application-limited throughout, so the framework and runtime
effects are both real here:

| | Express | Fastify | framework gain |
| --- | ---: | ---: | ---: |
| **Node** | 8,603 | 11,233 | **+30.6%** |
| **Bun** | 18,361 | 20,095 | **+9.4%** |
| runtime gain | **+113%** | **+79%** | |

**Batch 200** — the Bun row is database-limited:

| | Express | Fastify | framework gain |
| --- | ---: | ---: | ---: |
| **Node** | 13,916 | 14,980 | +7.7% |
| **Bun** | 29,272 | 29,119 | **−0.5% (null)** |
| runtime gain | **+110%** | **+94%** | |

The two changes are **not additive, and the interaction is negative**: Fastify is
worth +30.6% on Node at batch 33 but only +9.4% on Bun. Bun's HTTP layer is
already fast, so there is less framework overhead left for Fastify to remove.
The same logic taken one step further explains batch 200: once PostgreSQL is the
constraint, the framework is worth nothing at all.

This was predicted before the runs from the CPU profile and the Bun CPU columns,
and both halves of the prediction held — a gain at batch 33, a null at batch 200.

## 5. What this means

- **The runtime is the decision.** Bun roughly doubles throughput at both batch
  sizes and is the only configuration that clears 15,000 logs/s. Fastify is a
  single-digit refinement on top of it.
- **Fastify is still defensible on Bun**, on two grounds that are not throughput
  at the target batch size: +9.4% at small batches, which the client chooses, and
  an aggregate p95 roughly halved at batch 33.
- **Neither change touches the real remaining bottleneck.** At batch 200 on Bun
  the database is the ceiling. Further application work has nothing to win there;
  the next real gains are in PostgreSQL — or in the allocation reduction that is
  still unmeasured (`computeRollups` 9.6%, `csv` 5.2% of on-CPU on Node).

## 6. Not measured

- Batches 50 and 500 on this branch.
- The cursor drain under any of the four configurations, like-for-like. Page p95
  (87 ms against an 8 ms target) remains the worst outstanding miss and the one
  path no experiment today has moved.
- A CPU profile of Fastify + Bun. Bun's profiler is not V8's, so the `.cpuprofile`
  tooling used on Node does not transfer directly.
