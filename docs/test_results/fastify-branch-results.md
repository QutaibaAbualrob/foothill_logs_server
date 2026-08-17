# Fastify branch — implementation and measured result

**Branch:** `perf/fastify-node` at `68766fe` ("Swap the HTTP layer from Express to Fastify")
**Baseline:** `main` at `1bfb036`
**Date:** 2026-08-17
**Verdict: Fastify is ~8% faster** at batch 200 and wins every paired run, with
all gates green. It meets the "commit to main only if the measurements show it's
worth it" bar. The merge decision is the owner's.

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

1. **+39% — cross-session baseline.** The branch was compared against a `main`
   run measured earlier the same day. Re-measuring `main` in the same session
   gave 10,532 logs/s at batch 33 where the morning run gave 8,170: the host
   drifts by **~29%** between sessions. Retracted.

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
