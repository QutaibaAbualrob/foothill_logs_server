# Glossary — performance and measurement terms

> **For a reader who has not met these terms before.** Every term used in
> [`RESULTS.md`](RESULTS.md), the README's performance sections and the
> measurement write-ups is defined here, in plain language, with a real number
> from this project so it is concrete rather than abstract.
>
> Nothing here is a new claim. It explains vocabulary.

**[← Back to *Where to go next*](../README.md#where-to-go-next)**

---

## Contents

| | Section |
| --- | --- |
| **1** | [Percentiles — start here](#1-percentiles--start-here) |
| **2** | [Throughput](#2-throughput) |
| **3** | [Latency](#3-latency) |
| **4** | [Errors and status codes](#4-errors-and-status-codes) |
| **5** | [Resources](#5-resources) |
| **6** | [Eventual consistency and freshness](#6-eventual-consistency-and-freshness) |
| **7** | [Load scenarios](#7-load-scenarios) |
| **8** | [Harness and measurement terms](#8-harness-and-measurement-terms) |
| **9** | [Database terms](#9-database-terms) |
| **10** | [This project's own vocabulary](#10-this-projects-own-vocabulary) |
| **11** | [How the total is scored](#11-how-the-total-is-scored) |

---

## 1. Percentiles — start here

If you read only one entry, read this one. **Almost every latency number in this
project is a p95, not an average**, and the difference is the whole point.

Line up every request by how long it took, slowest last. Then:

```
        fastest ────────────────────────────────────────────── slowest
        │                                              │    │   │
        p50                                           p95  p99  max
     "typical"                                    "slow tail"
```

| Term | Meaning |
| --- | --- |
| **p50** (median) | Half of requests were faster than this. The *typical* experience |
| **p95** | **95% of requests were faster than this.** One request in twenty was slower |
| **p99** | 99% were faster. One in a hundred was slower |
| **max** | The single worst request observed |

**Why not the average?** An average hides stalls. A thousand requests at 5 ms
and ten requests at 3 seconds average out to ~35 ms — which looks fine, and
describes nobody's actual experience. The p95 would be ~5 ms and the p99 would
expose the 3-second stall. **Percentiles show the tail; averages bury it.**

**Why p95 specifically?** It is slow enough to catch real problems and stable
enough not to swing on one unlucky request. p99 and max are much noisier — a
single garbage-collection pause or checkpoint moves them.

*Concrete:* this project's request latency p95 fell from **2,078 ms to 8.18 ms**
across three changes. That means the slowest 5% of requests went from about two
seconds to about eight milliseconds.

<sub>[↑ Contents](#contents) · [← Where to go next](../README.md#where-to-go-next)</sub>

---

## 2. Throughput

**How much work went through, per unit time.**

| Term | Meaning |
| --- | --- |
| **Logs per second** (`logs/s`) | Accepted log entries written per second. **The headline throughput number.** The target here is 15,000 /s |
| **Offered rate** | What the load generator *tried* to send. Distinct from what was accepted |
| **Accepted logs** | Entries the service took and committed. `1.71M logs` in one 2-minute run |
| **Rejected logs** | Entries refused by validation — a bad level, a malformed timestamp. **`0` throughout this project** |
| **HTTP requests** | Requests received, *not* log entries. A batch of 200 logs is **one** request |
| **Duration** | How long the measurement window ran |

**Accepted vs offered is the distinction that matters.** If a generator offers
15,000 /s and the service accepts 14,999 /s, it kept up. If it accepts 4,000 /s,
the rest was refused or queued — and the throughput figure alone will not tell
you which.

> **A throughput number with a non-zero error rate is not a throughput number.**
> A service can "achieve" high throughput by failing fast. Always read the two
> together.

<sub>[↑ Contents](#contents) · [← Where to go next](../README.md#where-to-go-next)</sub>

---

## 3. Latency

**How long things took.** Three different latencies are measured here, and they
answer different questions.

| Term | What it measures |
| --- | --- |
| **Request latency (p95)** | End-to-end time for *any* HTTP request — reads and writes together. The broadest measure |
| **Ingestion latency (p95)** | Time from `POST /logs` arriving to its response. Because this service answers only **after the transaction commits**, it includes queue wait + database write |
| **Aggregate p95** | Time to answer `GET /logs/aggregate`. Tracked separately because it was the single most valuable number in the project — nine scoring points rode on it |

*Concrete, across the three graded runs:*

| | run 5 | run 6 | run 7 |
| --- | ---: | ---: | ---: |
| Request p95 | 2,078 ms | 588 ms | **8.18 ms** |
| Ingestion p95 | 65 ms | 72 ms | **8.90 ms** |
| Aggregate p95 | 2,170 ms | 604 ms | **1.00 ms** |

<sub>[↑ Contents](#contents) · [← Where to go next](../README.md#where-to-go-next)</sub>

---

## 4. Errors and status codes

| Term | Meaning |
| --- | --- |
| **Error rate** | Share of requests that failed. **0.00%** in the final runs |
| **HTTP error rate** | Same, counted from HTTP status codes |
| **POST status success rate** | Share of ingest requests that returned success. **100%** throughout |
| **POST status code (min / max)** | The lowest and highest status seen. `200 OK` for both means *every* ingest succeeded |

**The status codes this service uses:**

| Code | Meaning here |
| --- | --- |
| `200` | Success — and for `POST /logs`, the rows are **committed and queryable** |
| `400` | The client's request was invalid |
| `413` | Body too large |
| `503` | The service is unavailable *on purpose* — queue full, shutting down, or database unreachable. Always carries `Retry-After` |

> **`503` is not a crash.** It is **backpressure**: the service refusing work it
> cannot safely accept, rather than running out of memory or acknowledging data
> it never wrote. A `503` under overload is the system working as designed.

<sub>[↑ Contents](#contents) · [← Where to go next](../README.md#where-to-go-next)</sub>

---

## 5. Resources

Both containers run under hard caps: **application 0.5 CPU / 256 MB**,
**PostgreSQL 1 CPU / 1 GB**.

| Term | Meaning |
| --- | --- |
| **Application CPU (avg / max)** | Processor use by the service container |
| **PostgreSQL CPU (avg / max)** | Processor use by the database container |
| **Application / PostgreSQL memory** | Resident memory. Peaks: **114 MiB** of 256, **544 MiB** of 1 GB |

**Why CPU percentages can exceed 100%.** These are *per-CPU* percentages. A
container capped at 1.0 CPU showing **102.61%** briefly used slightly more than
its share before the scheduler throttled it. For the 0.5-CPU application, its
ceiling appears as **~50%** — so "47% CPU" means it is at ~94% of what it is
allowed.

**Why this matters more than it sounds.** Which container is saturated tells you
where the constraint is, and therefore what work is worth doing:

| | Application | PostgreSQL | Constraint |
| --- | ---: | ---: | --- |
| Early | 5.42% of its cap | 75.60% of its cap | **Database** |
| Final | 18.92% | **21.50%** | Neither — headroom on both |

<sub>[↑ Contents](#contents) · [← Where to go next](../README.md#where-to-go-next)</sub>

---

## 6. Eventual consistency and freshness

**The question: once the service says a log is accepted, when can you actually
read it back?**

| Term | Meaning |
| --- | --- |
| **Read-after-write success rate** | Share of probes that found their own row immediately after writing it |
| **Accepted records** | Rows the service confirmed it took |
| **Visible records** | Rows a reader could actually find afterwards |
| **Missing records** | `accepted − visible` — rows confirmed but not yet findable |
| **Drain** | A time window (30 s here) in which the reader repeatedly tries to catch up to everything accepted |
| **Timeout count** | Probes that gave up before answering |

**In this design there is no visibility lag by construction**, because a `200`
is sent only after the transaction commits. That was verified rather than
assumed: a probe after every accepted write against a 3.17 M-row database found
its row on the **first attempt 3,821 times out of 3,821**.

> **A gap between accepted and visible does not always mean the data is
> missing.** It can mean the *reader* could not traverse fast enough inside the
> window. That distinction is exactly what
> [`RESULTS.md` §16](RESULTS.md#16-what-is-deliberately-not-claimed) records as
> unresolved on the retired harness.

<sub>[↑ Contents](#contents) · [← Where to go next](../README.md#where-to-go-next)</sub>

---

## 7. Load scenarios

Four different shapes of traffic, each asking a different question.

| Scenario | Shape | Question it asks |
| --- | --- | --- |
| **Load** | A steady 15,000 logs/s for 120 s | *Can it hold the target rate?* — the primary scenario |
| **Stress** | Staged escalation: 15,000 → 22,500 → 30,000 logs/s | *Where does it start to bend?* |
| **Spike** | A sudden jump in offered rate | *Does a burst break it, or does it absorb it?* |
| **Breakpoint** | Rate climbs until something gives | *Where is the ceiling, and how does it fail?* |

**Failure is expected in breakpoint.** A non-zero error rate there is the point
of the scenario — the useful question is *how* it fails. Shedding with `503`
and staying alive is a pass; crashing is not.

<sub>[↑ Contents](#contents) · [← Where to go next](../README.md#where-to-go-next)</sub>

---

## 8. Harness and measurement terms

| Term | Meaning |
| --- | --- |
| **Machine speed factor** | How fast the measuring host is against a reference machine. This project measured at **~0.12×** — roughly eight times slower. **Latency numbers are not comparable across different factors** |
| **Generator-limited** | The *load generator* could not keep up. The reported figure is a **floor**, not a ceiling — the service was never asked for more |
| **Service-limited** | The *service* was the constraint. This is what you want to know; it was **`false` in every scenario of every final run** |
| **Dropped iterations** | Requests the generator failed to start on schedule — a symptom of generator-limiting |
| **Threshold passed** | Whether a scenario met its own pass criteria |
| **Spread** | Highest minus lowest across repeated runs. **Always report it** — a mean without a spread hides how noisy the measurement was |
| **Interleaving** | Running A, B, A, B, A, B rather than all of A then all of B, so drift cannot masquerade as a result |
| **Screen vs evidence** | A *screen* is a quick look that guides what to measure next. *Evidence* meets the full standard. Screens must never be quoted as results |

> **Measured noise here:** ~6% for a repeated build within one session, ~11%
> across sessions. An effect smaller than that is not an effect.

<sub>[↑ Contents](#contents) · [← Where to go next](../README.md#where-to-go-next)</sub>

---

## 9. Database terms

| Term | Meaning |
| --- | --- |
| **WAL** (write-ahead log) | PostgreSQL writes every change to a log *before* the data files, so a crash can be recovered. More WAL per row = more write cost |
| **`COPY`** | PostgreSQL's bulk-load command — far cheaper per row than individual `INSERT`s |
| **Transaction / commit** | A group of changes that either all succeed or all fail. "Committed" means durably applied |
| **`synchronous_commit`** | Whether a commit waits for WAL to reach disk. `off` is faster but can lose recently acknowledged writes in an unclean crash |
| **B-tree** | The ordinary index structure. Fast lookups and ordered scans, maintained on every write |
| **GIN index** | An index for "does this document contain this?" — used here for JSONB attributes |
| **Buffer hit ratio** | Share of reads served from memory rather than disk. **96.2%** here — meaning the workload is CPU-bound, not disk-bound |
| **Partition** | One physical slice of a logically single table. Here, one per month |
| **Partition pruning** | The planner skipping partitions that cannot contain matching rows |
| **Vacuum** | Reclaiming space from deleted rows. Dropping a partition avoids it entirely |
| **Checkpoint** | Periodically flushing changes to data files. Can cause latency spikes |
| **`EXPLAIN (ANALYZE, BUFFERS)`** | Asks PostgreSQL what it actually did: which plan, how long, how many pages touched |

<sub>[↑ Contents](#contents) · [← Where to go next](../README.md#where-to-go-next)</sub>

---

## 10. This project's own vocabulary

| Term | Meaning |
| --- | --- |
| **Group commit** | Coalescing several concurrent requests into **one** transaction, so the fixed per-transaction cost is amortised across thousands of rows |
| **Batch size** | How many log entries a client sends per request. The client chooses it, and it changes performance dramatically — see the batch-size curve |
| **Backpressure / shedding** | Refusing work with `503` when the queue is full, rather than growing memory or lying about acceptance |
| **Keyset (cursor) pagination** | Paging by "give me rows after *this* position" rather than `OFFSET n`. Page cost stays constant regardless of depth |
| **Cursor** | The opaque signed token encoding that position. Bound to the filter set, so it cannot be replayed against different filters |
| **Drain** | Walking every page from newest to the true end — the read-path stress test |
| **Rollup** | A summary table holding one pre-computed count per minute, per service, per level |
| **Edge slice** | When a query range does not land on minute boundaries, the partial minutes at each end are counted exactly from raw rows while the interior comes from the rollup |
| **Mutation testing** | Deliberately breaking the code to check the tests actually fail. **10 defects injected here; all caught** |
| **Failure drill** | Killing the database and the service mid-run to confirm nothing acknowledged is lost |

<sub>[↑ Contents](#contents) · [← Where to go next](../README.md#where-to-go-next)</sub>

---

## 11. How the total is scored

The measurement tool reports a total out of 100, split across four categories:

| Category | Max | What it measures |
| --- | ---: | --- |
| **Correctness** | 15 | Does the API behave exactly as specified? Pass/fail checks |
| **Reliability** | 20 | Did every scenario complete without the service crashing? |
| **Performance** | 50 | Throughput, error rate and latency, weighted together |
| **Queries** | 15 | Aggregate latency, plus eventual-consistency checks |

**Performance is four weighted components**, and the shape matters — each has a
**cliff** past which it contributes nothing:

| Component | Weight | Cliff |
| --- | ---: | --- |
| Throughput | 0.40 | Scales with `logs/s ÷ 15,000` |
| Errors | 0.30 | Zero above ~3% error rate |
| Latency | 0.20 | Full marks at ≤ 100 ms; zero above 1,000 ms |
| Sustained bonus | +0.05 / +0.10 | Awarded at high sustained rates |

**Queries** is `9 × (1 − aggregate_p95 ÷ 500) + 6 × (scenarios passing eventual
consistency ÷ 4)` — which **zeroes at 500 ms**. That cliff is why aggregate p95
was the most valuable single number in the project.

*The scoring model was verified to two decimal places against seven separate
runs before being planned against — see
[`RESULTS.md` §5](RESULTS.md#5-the-final-submission-in-detail).*

<sub>[↑ Contents](#contents) · [← Where to go next](../README.md#where-to-go-next)</sub>

---

**[← Back to *Where to go next*](../README.md#where-to-go-next)** ·
[Results](RESULTS.md) · [Schema](SCHEMA.md) · [Design decisions](DESIGN-DECISIONS.md)
