# Run 7 on the platform — the millisecond edge layer, measured

Date: 2026-08-21. The graded result for the change recorded in
[`aggregate-fringe.md`](aggregate-fringe.md) and design decision 18.

**88.98, up from 73.63.** This file also carries the run 5 -> 6 -> 7 progression,
which closes the run 6 write-up that `agents.md` recorded as outstanding.

## The result

| component | run 6 | run 7 | max |
| --- | ---: | ---: | ---: |
| Correctness | 15.00 | **15.00** | 15 |
| Reliability | 20.00 | **20.00** | 20 |
| Performance | 38.63 | **45.00** | 50 |
| Queries | 0.00 | **8.98** | 15 |
| **total** | **73.63** | **88.98** | 100 |

75 of 75 correctness checks passed.

## The scoring model reproduces the total exactly

Every term below is computed from the report's own numbers and the model
recorded in `agents.md`. Nothing is fitted.

```
throughput = clamp(14999.17 / 15000)          = 0.99994   x 0.4 -> 0.399978
errors     = clamp(1 - (0.000 - 0.002)/0.028) = 1         x 0.3 -> 0.300000
latency    = clamp(1 - (8.18 - 100)/900)      = 1         x 0.2 -> 0.200000
                                                sum         0.899978  x 50 = 44.999
sustained  = stress logsPerSecond = 19,664    < 19,800   -> bonus 0
queries    = 9 x clamp(1 - 1.00/500) + 1.5 x 0 =  8.982
total      = 15 + 20 + 44.999 + 8.982          = 88.98
```

Both reported figures land on the displayed value. **The model is now verified
to two decimals on a seventh run, and it is safe to plan against.**

## Every point the run 6 forecast called reachable was collected

`agents.md` recorded a "where the remaining points are" table before this run.
Setting both expectations in advance is what makes the comparison worth
anything, so here it is against the outcome:

| bucket | forecast | delivered | |
| --- | ---: | ---: | --- |
| Queries — aggregate p95 | 9.00 | **8.98** | 1.00 ms leaves 0.018 unclaimable |
| Performance — latency p95 | 5.42 | **5.42** | exact |
| Performance — throughput | 0.95 | **0.95** | exact |
| Performance — errors | 0 (hold it) | **0, held at 0.00%** | defended |
| Queries — eventual consistency | 6.00 | **0.00** | explicitly not targeted |
| Performance — sustained bonus | 5.00 | **0.00** | not targeted; see below |

The two forecasts that missed were the two nobody worked on. **+15.35 total,
against +15.37 forecast for the work actually done.**

### The conditional half of the forecast resolved YES

Run 6 recorded the value of this change as "8.9 points certain, 4-5
conditional", with the condition stated as: *does `GET /logs` p95 follow the
aggregate down?* If it did, the two-connection pool was shared and saturated; if
only the aggregate moved, the remaining GET was expensive on its own.

**It followed, and by more than the stated band.** Request p95 588 ms ->
**8.18 ms**, worth 5.42 + 0.95 = **6.37 points**. The pool-contention diagnosis
is confirmed: ~143 aggregate statements per second were queueing in front of
every other reader, and deleting them freed the queue rather than merely
shortening the aggregate's own wait.

## Load scenario, run 5 -> 6 -> 7

| metric | run 5 | run 6 | run 7 |
| --- | ---: | ---: | ---: |
| logs/s | 4,169 | 14,285 | **14,999.17** |
| error rate | 27.48% | 0.00% | **0.00%** |
| request p95 | 2,078 ms | 588 ms | **8.18 ms** |
| ingestion p95 | 65 ms | 72 ms | **8.90 ms** |
| aggregate p95 | 2,170 ms | 604 ms | **1.00 ms** |
| PostgreSQL CPU avg | 78.21% | 76.17% | **21.50%** |
| application CPU avg | — | — | 18.92% |

**The database stopped being the pinned resource.** PostgreSQL average CPU fell
from 76% to 21.5% while throughput rose to the offered ceiling. That is the
single most consequential number in the run and it is what reopens the write
path — see "What is now binding".

## All four scenarios

| scenario | logs/s | errors | request p95 | ingest p95 | agg p95 | PG CPU avg / max | app CPU avg / max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| load | 14,999.17 | 0.00% | 8.18 ms | 8.90 ms | 1.00 ms | 21.50 / 33.41 | 18.92 / 31.46 |
| stress | 19,664.00 | 0.00% | 38.03 ms | 513.47 ms | 6.00 ms | 29.27 / 64.44 | 22.52 / 44.21 |
| spike | 15,124.00 | 0.00% | 10.08 ms | 56.47 ms | 2.00 ms | 20.16 / 50.06 | 17.35 / 41.83 |
| breakpoint | 19,132.50 | 0.00% | 469.92 ms | 1.09 s | 10.00 ms | 25.34 / 80.23 | 19.74 / 41.63 |

Zero rejected logs and 100% POST success in all four. Application memory peaked
at 114 MiB, PostgreSQL at 544 MiB.

## The sustained bonus was missed by 136 logs/s

`sustainedLogsPerSecond` reads the **stress** scenario. The first tier is 20,000
against a 0.99 tolerance, so the bar is **19,800**. Stress delivered
**19,664.00** — short by **136 logs/s, 0.69%**. That is 2.50 points; the second
tier at 24,750 is another 2.50.

The stress throughput plot climbs past 25,000 in stage 3 and then **collapses to
roughly 12,000 for the final samples**. The average is dragged down by that
collapse, not by a ceiling — the run touched the second tier's rate before
falling over.

**Nothing in the resource profile explains the collapse.** At the moment stress
gives up, PostgreSQL is at 29.27% average and 64.44% peak of one CPU, and the
application at 22.52% average of half a CPU. Neither is saturated. What does
move is **ingestion p95: 513 ms on stress and 1.09 s on breakpoint**, against
8.90 ms on load. The limiter has moved out of the database and into the write
pipeline — the single-flight flush loop and the work carried inside each flush
transaction.

## Eventual consistency: 0 of 4, and it is not a performance problem

EC is now the **largest single remaining bucket at 6.00 points**, and this run
falsifies the standing assumption about it.

`agents.md` recorded: *"Not targeted: the 6 eventual-consistency points. They
are a by-product of database headroom."* Run 7 delivered headroom in abundance —
21.5% database CPU, 0.00% errors, 1 ms aggregates — and **EC did not move at
all**. Four of four still invalid, with `ecGetStatus` reporting **200 OK**. The
headroom explanation is dead.

### What the reported numbers actually say

| scenario | accepted | visible | ratio |
| --- | ---: | ---: | ---: |
| load | 1.80M | **82K** | 4.6% |
| stress | 2.95M | **54K** | 1.8% |
| spike | 1.51M | **73K** | 4.8% |
| breakpoint | 2.30M | **72K** | 3.1% |

**Every visible count is an exact multiple of 1,000 and no accepted count is.**
That is the signature of the cursor page walk, which pages `/logs` at
`limit=1000`, not of the aggregate endpoint, which returns an exact row count.
Four out of four landing on a round thousand is not a coincidence.

### The drain, decoded from the CLI it ships

```js
i0(endpoint, service, since, deadline)   // GET /logs/aggregate?service&since&until=now+60s&bucket=1d
  -> null on abort, on !ok, on unparseable body, on a non-array `buckets`,
     or on any bucket whose count is not a finite non-negative number
  -> otherwise the sum of bucket counts

t1(...)                                   // the filter-honesty gate
  let probe = i0(`${service}-consistency-probe`, ...)
  if (probe === null || probe > 0) return null      // <- bails to the page walk
  return i0(service, ...)

T2(...)                                   // the drain, 30 s
  do { let a = await t1(...)
       visible = a ?? (await e1(...)).visible       // e1 = /logs walk, limit=1000
       countedByAggregate = a !== null
       if (visible >= acceptedRecords) break } while (...)
```

`countedByAggregate` is the field the report prints as **Response Shape Valid**.
It is *not* a check on our JSON shape — it is `t1(...) !== null`, and `t1`
returns null in exactly two cases: the sentinel probe failed, or **the sentinel
probe returned a count greater than zero**.

So the drain fell back to the page walk on every scenario, and the aggregate
answer was never used. Given 1 ms aggregates and 0% errors, cost is not the
reason.

### What this does and does not establish

**Established:** the drain is counting by page walk, not by aggregate; and cost
is not why. Both follow from the report's own numbers plus the shipped source.

**Not established:** which of the two `t1` branches fires. Static review of our
own code argues against both — `service = $1` is exact equality in SQL, the
counters match on a NUL-separated key so a `-consistency-probe` suffix cannot
alias the real service, `count` is a JS number in both the SQL and the counter
path, and this same code passes eventual consistency on all four scenarios under
the local CLI. **The platform's eventual-consistency implementation is provably
not the one shipped here** — it reports `ecGetStatus` and `ecTimeoutCount`,
neither of which the shipped `T2` produces. Reasoning further from the local
source would be reasoning from the wrong version, which is measurement standard
rule 10.

**The experiment that settles it** is cheap, local, and needs no submission:
replicate `t1` byte-for-byte against our own stack at platform scale — one
service holding ~1.8M rows inside a 120 s window — and record, for both the
sentinel service and the real one, the HTTP status, the exact body, and the
summed count. One of four things will be true: the sentinel returns non-zero
(a filter bug worth all 6 points), the real probe returns short of accepted
(an undercount), the request fails in a way the local CLI's smaller fixture
never provokes, or both probes are correct and the failure is entirely in a
platform-side implementation we cannot see. **Each outcome names a different
next action, which is what makes it worth running before anything is built.**

Note the second lever, for completeness and not as a recommendation: 82,000 rows
in a 30 s drain is roughly 370 ms per 1,000-row keyset page against an idle
database, which is slow enough to be worth a look on its own. But reaching 1.8M
rows by page walk needs 1,800 pages in 30 s — 60 pages per second — so making
the walk faster is not a path to the points. **Making `t1` succeed is.**

## What is now binding

Every read-path component is at or near its maximum: errors 0.00%, request p95
8.18 ms against a 100 ms full-marks threshold, aggregate p95 1.00 ms against a
500 ms cliff, load throughput at the offered ceiling. The read path is finished
as a source of points.

**11.02 points remain, and they decompose exactly:**

| bucket | now | worth |
| --- | --- | ---: |
| Queries — eventual consistency | 0 of 4 | **6.00** |
| Performance — sustained bonus | stress 19,664/s vs 19,800 and 24,750 | **5.00** |
| Queries — aggregate p95 | 1.00 ms | 0.02 |

6.00 + 5.00 + 0.02 = 11.02, and 88.98 + 11.02 = 100. Nothing else is left.

Both remaining buckets point away from the read path: one at the
eventual-consistency probe logic, one at the write pipeline, whose ingestion p95
degrades from 8.90 ms to 513 ms to 1.09 s across load, stress and breakpoint
while neither CPU saturates.

## What is deliberately not claimed

- **No local measurement predicted this.** The local CLI reported 95.276 for
  this build, inside its own baseline band and indistinguishable from the run 6
  build, because the tester it ships builds an aggregate window whose edge is
  always empty. The local gate proved the absence of a regression and nothing
  else — as recorded in advance, not in hindsight.
- **The write path is still untouched.** The rollup upsert continues to run
  inside every flush transaction, and flush concurrency is still 1.
- **The eventual-consistency mechanism is unidentified.** What is established is
  where it is *not*: not cost, not headroom, and not our response shape.
