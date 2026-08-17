# Fastify branch — implementation and measured result

**Branch:** `perf/fastify-node` at `68766fe` ("Swap the HTTP layer from Express to Fastify")
**Baseline:** `main` at `1bfb036`
**Date:** 2026-08-17
**Verdict: Fastify is ~8% faster at batch 200**, winning every paired run, with
all gates green. It meets the "commit to main only if the measurements show it's
worth it" bar. The merge decision is the owner's.

**Scope of that claim: batch 200 only.** It is the only point measured to the
standard in `agents.md` — interleaved, three repeats per side, clean volume per
run, build verified in-container. §3.5 reports an indicative ~25–35% at batch 33
from non-interleaved runs pooled across sessions; that is a **screen, not
evidence**, and is not part of this verdict. Batches 50 and 500 are unmeasured
to standard.

Read §3.1 before trusting any number in this file: three earlier readings of this
same experiment were wrong, for three different reasons, and the corrections are
recorded rather than quietly dropped.

---

## 1. What the branch changes

| File | Change |
| --- | --- |
| `src/app.ts` | Express → Fastify. Same routes, same error mapping, same 404/error body shapes. |
| `src/index.ts` | Fastify owns the HTTP server; `app.listen()` and `app.close()` replace `createServer`/`server.close`. Timeouts set on `app.server` at the same values. |
| `src/query/parser.ts` | `RawQuery` was `Request["query"]` from Express; now a structural type matching `querystring.parse` output. |
| `package.json` | `express` + `@types/express` out, `fastify@5.12.0` in. |

`Dockerfile`, `docker-compose.yml`, migrations, SQL and the batcher are
untouched — so this branch should merge cleanly with a Bun branch that changes
the image and runtime.

Behaviour deliberately preserved:

- Fastify is configured with `querystringParser: querystring.parse` so repeated
  parameters still become arrays and `attr.<key>` stays one flat key — Express
  ran with `query parser: "simple"`, and the reliability matrix depends on it.
- The body limit is converted from `"4mb"` to a byte count (`parseByteSize`),
  because Fastify wants a number where Express accepted a string.
- Malformed JSON arrives as `FST_ERR_CTP_INVALID_JSON_BODY` (Fastify 5 name)
  instead of body-parser's `entity.parse.failed`. Any *other* framework 4xx now
  maps to its own status, so no client error can surface as a 500.

## 2. Gates — all green on the branch

| Gate | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npm test` | **32/32**, 0 skipped, with `TEST_DATABASE_URL` set so both integration tests actually execute |
| `npm run smoke` (G1) | Pass — `{"status":"ok","accepted":5,"paginated":5,"aggregateCount":5}` |
| `npm run reliability` (G2) | **73 checks, 0 failures** |
| `npm run drill` | **PASS** — all endpoints 503 + `Retry-After` during outage, 0 restarts, SIGTERM exit 0, `db +192000 = accepted 192000` |

Two gate failures were found and fixed during the swap, both from the same
cause: the Fastify 5 error code is `FST_ERR_CTP_INVALID_JSON_BODY`, not
`FST_ERR_CTP_INVALID_JSON`. Unmapped, malformed JSON returned **500** instead of
400, failing both smoke and one reliability check.

## 3. The measurement

### 3.1 Three wrong readings, and what caused each

This experiment produced a "+39%", a "−11.8%" and a "+13.4%" before it produced
a trustworthy number. All three failures are worth keeping, because each has a
different cause and each would recur.

1. **+39% — weak comparison, but retracted for the wrong reason.** The branch
   was compared against a `main` run measured earlier the same day, on a single
   non-interleaved pair. That is genuinely weak evidence and the figure should
   not have been quoted with confidence.

   The *explanation* given at the time was wrong, though. I re-measured "main",
   got 10,532 logs/s at batch 33 against the morning's 8,170, and concluded the
   host drifts ~29% between sessions. It does not. That re-measurement was
   itself Fastify — it ran while the Fastify commit sat on `main` (failure 2
   below) — so I compared Fastify against Express and called the difference
   drift.

   An independent Bun-branch session later measured Node + Express at batch 33
   twice, at **8,638.9 and 9,075.9 logs/s**, corroborating the 8,170 baseline.
   Three Express runs across two sessions span about 11%; same-build repeats
   within a session vary about 6%. **There is no tens-of-percent drift on this
   host.** See §3.5 for what the batch-33 numbers actually say.

2. **−11.8% — swapped labels.** The A/B loop checked out `main` and
   `perf/fastify-node` by name. But the Fastify commit had landed on **`main`**,
   and `perf/fastify-node` still pointed at the pre-Fastify baseline
   (`main@{0}: commit: Swap the HTTP layer from Express to Fastify`;
   `perf/fastify-node@{0}: branch: Created from HEAD`, never moved). Every run
   labelled "main" was Fastify and every run labelled "fastify" was Express, so
   the sign was inverted. Retracted; the underlying data is valid once relabelled
   and appears below as the first of the two confirming A/Bs.

3. **Both four-point curves were the same build.** The "Fastify curve" ran with
   uncommitted Fastify changes in the tree, and the "main re-run curve" ran after
   those changes were committed *to main* — so both measured Fastify. That
   comparison is void. Any figure derived from `fastify-b*.json` versus
   `main-rerun-b*.json` should be ignored, including the drain comparison: **no
   valid Express drain was measured on this host today.**

The lesson is procedural and now sits in `agents.md`: on this host, interleave
the branches, repeat at least three times, use a clean volume per run, report the
spread — and **verify from inside the container which build is running**, rather
than trusting a branch name.

**Calibration of the noise, corrected 2026-08-17.** Same build repeated within a
session varies about **6%**; across sessions about **11%** (three Express
batch-33 runs: 8,170 mine, 8,639 and 9,076 from an independent Bun-branch
session). The protocol is therefore not defence against a wildly unstable
machine — it is defence against **ordering effects, growing table size and
mislabelled builds**, which is what actually produced a +39% and a −11.8%
reading from the same two builds. A single non-interleaved pair still cannot
resolve a 10% effect, because 6–11% of noise sits underneath it.

### 3.2 The trustworthy A/B

Batch 200, concurrency 96, 30 s, fresh container and empty database per run,
branches alternating. Each run asks the container which framework it actually
has (`ls node_modules | grep -xE "fastify|express"`) and records the answer
beside the result.

| Run | Express (main, verified) | Fastify (branch, verified) | delta |
| --- | ---: | ---: | ---: |
| 1 | 13,532.1 | 15,096.3 | +11.6% |
| 2 | 13,835.3 | 14,629.9 | +5.7% |
| 3 | 14,379.1 | 15,214.1 | +5.8% |
| **mean** | **13,916** | **14,980** | **+7.7%** |

Fastify wins every pair. 0 errors in all six runs.

Aggregate p95 during ingestion also improves: Express 581 / 585 / 728 ms
(mean 631) against Fastify 567 / 592 / 502 ms (mean **554**), about 12% better,
both comfortably inside the 1 s requirement.

### 3.3 The earlier A/B, relabelled — an independent confirmation

The run described in §3.1 item 2, with its labels corrected, is a second
interleaved three-run A/B taken from clean volumes:

| Run | Express | Fastify |
| --- | ---: | ---: |
| 1 | 13,977.3 | 16,045.6 |
| 2 | 14,039.0 | 15,773.9 |
| 3 | 14,023.6 | 15,861.8 |
| **mean** | **14,013** | **15,894** |

**+13.4%**, Fastify winning all three pairs, with within-branch spread of ±0.2%
(Express) and ±0.9% (Fastify).

A warm-up-controlled variant — fresh container, one 30 s pass discarded, second
30 s pass measured — gives Express 13,932 against Fastify 14,824, **+6.4%**.

So across three independently taken sets, Fastify wins **all eight paired runs**,
by between 5.7% and 13.4%. The point estimate is sensitive to run conditions; the
direction is not.

### 3.5 Batch 33 — the gain is much larger at small batches

Correcting §3.1 item 1 leaves a real result behind it. Pooling every batch-33
run, including two Node + Express runs taken independently on the Bun branch:

| Build | Runs | logs/s |
| --- | --- | ---: |
| Express | mine, then two from the Bun-branch session | 8,170 / 8,639 / 9,076 |
| Fastify | two runs | 11,366 / 10,532 |

This suggests Fastify is roughly 25–35% faster at batch 33 against 7.7% at batch
200 — but **it does not meet the measurement standard and must not be quoted as
a result.** These runs were not interleaved, they sit at different positions in
growing-database sequences, and they span two sessions. Under the standard in
`agents.md` that makes them a screen. Batch 33 needs three interleaved pairs
with in-container verification before this number means anything.

This is exactly what the profile predicted and I failed to notice at the time:
Express + router + `_http_*` is **19.3% of on-CPU at batch 33 and 7.5% at batch
200** (`batch33-and-cpu-profile.md` §3). The framework's benefit tracks the
framework's share of CPU at each batch size. The two measurements agree; the
"drift" story was noise invented to explain a gap that had a mechanical
explanation sitting in the profile.

Practical consequence: **the smaller the client's batches, the more the
framework matters** — and the service does not choose the batch size.

### 3.4 Read path — not measured

Both drain runs taken today were Fastify (§3.1 item 3). The framework's effect on
the cursor drain is **unmeasured**, and the earlier profile suggests it would be
small, since that path is bound by row materialisation and the database rather
than routing. If the drain page p95 target matters to the merge decision, it
needs an interleaved drain A/B of its own.

## 4. Why it wins, and what is still on the table

The ingest profile in `batch33-and-cpu-profile.md` §3 measured Express + router
self-time at 2.4–2.9% of on-CPU at batch 200 and predicted a gain of about that
size. The measured gain is **larger than the frames the profile attributed to
Express**. That is consistent with framework cost not being confined to
framework frames: Express's per-request wrappers and middleware chain also drive
allocation, and GC is ~34% of on-CPU. Removing allocation pressure pays out
through the GC bucket, which the self-time estimate could not see.

Still untested: **response schemas**. Fastify's `fast-json-stringify` advantage
only applies to routes that declare them, and this branch declares none — so the
measured +7.7% is Fastify's *floor*, achieved with generic serialisation. Adding
schemas for the four response shapes is a further experiment, most likely to pay
on `GET /logs` pages rather than on the small ingest response.

## 5. Recommendation

The branch clears the bar agents.md sets: gates green, measured improvement,
repeated and interleaved. Merging is reasonable. Two notes for the decision:

- The 0.5-CPU cap stays where it is; this changes what fits inside it, not the cap.
- Allocation reduction in `computeRollups` (9.6% of on-CPU) and `csv` (5.2%)
  remains the larger single target, and it is independent of this change.

## 6. Raw files

Under `bench/raw/` (gitignored), create-only:

- `ab3-{main,fastify-node}-b200-run{1,2,3}.json` — §3.2, the verified A/B
- `ab2-{main,fastify-node}-b200-run{1,2,3}.json` — §3.3; **labels inverted**, `ab2-main-*` is Fastify
- `warm-{main,fastify-node}-{warmup,measured}{1,2}.json` — §3.3 warm variant; same inversion
- `fastify-b{33,50,200,500}.json`, `main-rerun-b{33,50,200,500}.json`, `fastify-drain.json`, `main-rerun-drain.json` — **both sequences are Fastify**; void as a comparison, retained as evidence of the mistake
- `testdb.override.yml` — publishes PostgreSQL on 55432 so the integration tests run; test-only, never shipped
