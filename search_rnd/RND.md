# R&D Notes: Log Ingestion and Query Service

> Status: concept and research only. No application, Docker, database, or benchmark
> implementation exists yet. This document is a working record for the final
> TypeScript project; it is not the submission README.
>
> Fact-check revision (2026-08-15): this document now distinguishes the supplied
> evaluator contract from additional production policies proposed by the R&D.
> In particular, crash-durable acknowledgement and `503 + Retry-After`
> backpressure are recommended guarantees, not explicit statements in the
> supplied project brief.

## 1. Project brief, distilled

Build a simplified Datadog/Grafana Loki-style service that receives structured
application logs, stores them in PostgreSQL, exposes log search and time-bucketed
aggregation, and removes expired data.

### Required contract

| Endpoint | Required behaviour |
| --- | --- |
| `GET /health` | Returns `200` only after the database is connected, migrations have run, and the service is ready for logs. |
| `POST /logs` | Accepts a `logs` batch. Valid entries are accepted even if other entries are invalid; the response reports each rejected array index and reason. |
| `GET /logs` | Supports freely combinable service, level, time-range, `attr.<key>`, case-insensitive message-substring, limit, and opaque cursor filters. Results are deterministically ordered by timestamp descending. |
| `GET /logs/aggregate` | Counts filtered logs in `1m`, `5m`, `1h`, or `1d` buckets, optionally grouped by service or level. |

Each log contains a timestamp, `debug`/`info`/`warn`/`error` level, service,
message, and optional flat attributes whose values are strings, numbers, or
booleans. Timestamps may not be more than five minutes in the future.

The evaluator requires `docker compose up`, port `8080`, the exact required
endpoint shapes, cursor pagination, safe parameterized SQL, migrations, CI, and
a README explaining the design and measured results. Optional features must be
additive and off by default when they would change core behaviour.

### Performance and resource envelope

| Area | Constraint or target |
| --- | --- |
| Application container | 0.5 CPU, 256 MB RAM |
| PostgreSQL container | 1 CPU, 1 GB RAM |
| Ingestion | At least 15,000 logs/second sustained, without dropped accepted requests or crashes |
| Querying | Primary aggregate query under 1 second at p95 while ingestion is active |
| Dataset | About 1,000,000 records representing roughly one month |
| Freshness | Newly accepted logs queryable within 20 seconds |
| Concurrent work | At least one aggregate request per second during ingestion |

These are performance goals to prove with measurements, not promises that can be
made before a benchmark is built.

## 2. Confirmed decisions

- The service will use **TypeScript** throughout. This is both a project
  requirement and the training focus.
- Initial scope is the complete required API plus an additive **JSON `GET /metrics`**
  endpoint. There is no dashboard, auth, tenancy, rate limiter, or additional
  monitoring container in the initial scope.
- PostgreSQL remains the source of truth for reads and writes. It may be tuned
  inside its stated 1 CPU / 1 GB container limit; every setting must be documented
  and benchmarked.
- Retention is configurable through `RETENTION_DAYS`, with a **30-day default**.
- This project will favour direct, parameterized PostgreSQL SQL over an ORM on the
  write path. The supplied brief names **Express**, so Express is the baseline HTTP
  framework. Alternatives in section 5 are research comparisons and should be used
  only if a deviation from the brief is explicitly accepted and justified.

## 3. Recommended direction to validate

### Data path

```text
HTTP batch
  -> per-entry TypeScript validation
  -> bounded in-memory micro-batch queue
  -> one durable PostgreSQL COPY transaction
  -> daily log partition and indexes
  -> commit acknowledgement to the waiting request
```

The queue should coalesce valid entries from multiple requests into modest `COPY`
transactions. As an **additional production guarantee selected by this R&D**, a
request receives `200` only after its valid entries commit; invalid entries remain
reported by their original request index. This removes per-row SQL round trips
while preserving the API's partial-batch behaviour. The supplied brief requires
sustained ingestion without dropped accepted requests, but it does not explicitly
define crash-durable HTTP acknowledgement semantics.

The queue must be bounded by both count and estimated bytes for resource safety.
The recommended overload policy is explicit backpressure (`503` and
`Retry-After`) before claiming any extra entries were accepted. This is preferable
to growing beyond the application's memory limit or replying `200` for uncommitted
data, but the exact `503`/header behavior is an added policy rather than a status
contract stated by the supplied brief.

To provide the added crash-durable acknowledgement guarantee, use normal,
WAL-backed tables and synchronous commits. Do **not** describe an unlogged table
or asynchronous commit as crash-durable: either can lose data after a crash even
though a request received success. If benchmark-only durability trade-offs are
ever evaluated, label and test them separately from the production policy.

### Schema and query direction

- Use a partitioned `logs` table with **daily time-range partitions**. Create the
  current retention window and a small future window during startup/maintenance.
  Remove fully expired partitions rather than deleting millions of rows.
- Generate a `BIGINT GENERATED ALWAYS AS IDENTITY` value in PostgreSQL for each
  accepted log. It is smaller and more insertion-friendly than a random UUID.
  Return it as a JSON string so TypeScript/JavaScript never loses integer precision.
  Cursor pagination uses `(timestamp, id)` as a deterministic descending key and
  fetches `limit + 1` rows to determine `next_cursor`.
- Keep the original `attributes` JSONB for API responses. If benchmarked attribute
  equality needs indexing, keep a second JSONB search representation with scalar
  values normalized to strings; `attr.<key>` is specified as a string comparison.
  This preserves response types while enabling a containment query and GIN index.
- Start with only indexes justified by required queries: time/id ordering,
  service plus time/id, JSONB attribute containment, and trigram message search.
  Do not add a B-tree index for every attribute or every low-selectivity level.
- Construct every optional filter from fixed SQL fragments and bind values as
  parameters. Attribute keys are values, never interpolated SQL identifiers.

The exact index set and partition granularity are hypotheses to verify with
`EXPLAIN (ANALYZE, BUFFERS)` and a repeatable load test. GIN and trigram indexes
make reads faster but add write amplification, so the fastest-looking query design
is not automatically the best ingestion design.

### Metrics proposal

`GET /metrics` returns a compact JSON document intended for manual inspection or
test tooling. It should expose bounded-cardinality counters and gauges such as
accepted/rejected log totals, request totals, queue depth/bytes, flush latency,
COPY failures, query durations by endpoint/status, and database-pool wait time.
It must never include service names, user IDs, messages, attribute values, or any
other high-cardinality label/value.

## 4. Limits and risks to design around

| Risk | Why it matters here | Direction |
| --- | --- | --- |
| Unbounded input | The API brief gives no maximum batch, message, or attribute size. Fixed 256 MB memory cannot safely buffer unlimited JSON or rejection responses. | Document a safe request limit, or implement streaming JSON parsing; test the load generator's actual batch size before fixing the limit. |
| Application CPU | JSON parsing, timestamp validation, error allocation, logging, and serialization share only half a CPU. | Use compiled/lightweight validation, no synchronous work, minimal request logging, and no ORM on ingestion. |
| PostgreSQL write amplification | Every GIN, trigram, and B-tree index is updated on each insert. | Begin with a small index set, batch with `COPY`, and remove indexes that plans do not use. |
| Read/write contention | Aggregate scans and GIN maintenance share one PostgreSQL CPU with ingestion. | Keep aggregate SQL set-based, use partition pruning and bounded DB pools, then measure p95 under concurrent load. |
| Retention maintenance | Row-by-row deletion produces locks, vacuum work, and table bloat. | Drop whole daily partitions after the retention boundary. |
| Out-of-window timestamps | Valid timestamps can be very old; allowing arbitrary historical days to create partitions can be abused. | Define and document a safe historical handling policy before implementation; do not silently reject otherwise valid core entries. |
| Durability shortcuts | Turning off `synchronous_commit`, using unlogged tables, or acknowledging queued data can improve a benchmark while weakening crash durability. | If adopting the R&D's added durable-ack policy, return success only after a normal synchronous PostgreSQL transaction commits; do not attribute that exact guarantee to the supplied brief. |

Candidate PostgreSQL settings to benchmark, not assume: a modest `shared_buffers`
budget (for example 256 MB), low connection count, appropriate WAL/checkpoint
settings, and JIT disabled for short queries. `fsync` and synchronous commit stay
enabled for accepted records.

## 5. TypeScript implementation choices to research

| Option | Why to consider it | Trade-off |
| --- | --- | --- |
| **Express + `pg` + `pg-copy-streams`** | Matches the framework named by the supplied brief while retaining direct control of `COPY` and query plans. | Express adds less built-in schema validation than some alternatives, so per-entry validation and error mapping remain application responsibilities. |
| **Fastify + `pg` + `pg-copy-streams`** | Mature Node server, strong TypeScript support, low overhead, and direct control of `COPY` and query plans. | Deviates from the framework named by the brief unless that deviation is explicitly accepted; also requires careful per-entry validation beyond route schemas. |
| **Native `node:http` + `pg`** | Maximum control over streaming, request limits, HTTP semantics, and the learning value of building an HTTP server. | More routing, parsing, error-handling, and testing code to own. |
| **Hono + `pg`** | Small, TypeScript-first API with a supported Node adapter. | A less conventional choice for a database-heavy Node service; assess its body/parser behaviour under the actual load. |
| **Kysely for reads + raw `pg` for `COPY`** | Type-safe query construction can improve maintainability while retaining raw SQL for the write hot path. | Adds another abstraction to learn; generated SQL still needs plan review. |

Avoid an ORM-first hot path (for example Prisma) unless it demonstrably supports the
required `COPY` path and preserves control of SQL/query plans. Avoid adding a
cluster, cache, message broker, dashboard, or extra metrics container before the
core benchmark passes: the resource envelope is deliberately small.

Selection criteria: use the option that can enforce the exact API contract,
bounded request memory, graceful shutdown, and predictable throughput while still
being explainable in a live TypeScript demo. Fastify is the current leading
candidate; it is not a final choice yet.

## 6. Reading and code-study list

### PostgreSQL - required reading

- [Bulk loading and `COPY`](https://www.postgresql.org/docs/current/populate.html)
- [Table partitioning and maintenance](https://www.postgresql.org/docs/current/ddl-partitioning.html)
- [JSONB types and GIN index trade-offs](https://www.postgresql.org/docs/current/datatype-json.html)
- [`pg_trgm` substring-search indexes](https://www.postgresql.org/docs/current/pgtrgm.html)
- [Index design and `EXPLAIN` usage](https://www.postgresql.org/docs/current/indexes-examine.html)
- [Durability versus non-durable performance settings](https://www.postgresql.org/docs/current/non-durability.html)

### Open-source systems - study concepts, do not copy their infrastructure

- [Grafana Loki architecture](https://grafana.com/docs/loki/latest/get-started/architecture/) and
  [label/cardinality guidance](https://grafana.com/docs/loki/latest/get-started/labels/): learn why a
  small number of useful indexed dimensions beats indexing every field.
- [VictoriaLogs ingestion documentation](https://docs.victoriametrics.com/victorialogs/data-ingestion/):
  compare ingestion API and bulk-ingestion choices, while remembering that its
  custom storage engine is outside this project's PostgreSQL constraint.
- [`node-postgres`](https://node-postgres.com/) and
  [`pg-copy-streams`](https://github.com/brianc/node-pg-copy-streams): assess the
  Node/PostgreSQL client and `COPY FROM STDIN` integration.

### TypeScript server and SQL references

- [Fastify server reference](https://fastify.dev/docs/latest/Reference/Server/)
- [Node.js `node:http` documentation](https://nodejs.org/api/http.html)
- [Hono on Node.js](https://hono.dev/docs/getting-started/nodejs)
- [Kysely TypeScript SQL query builder](https://www.kysely.dev/)

### Books

- [*PostgreSQL for Data Architects*](books/001-PostgreSQL-for-Data-Architects.pdf)
  by Jayadevan Maymala: PostgreSQL architecture, physical design, data movement,
  JSONB, and historical partitioning techniques.
- [*PostgreSQL 9.6 High Performance*](books/007-PostgreSQL.9.6.High.Performance.2017.5.pdf)
  by Ibrar Ahmed and Gregory Smith: benchmarking, memory, WAL/checkpoints,
  statistics, indexes, query plans, partitioning, and bulk loading.
- [*Designing Data-Intensive Applications*](https://dataintensive.net/) by Martin
  Kleppmann and Chris Riccomini (latest edition): storage/retrieval, encoding,
  partitions, and transaction trade-offs. The local library contains the
  [first-edition PDF](<books/Martin Kleppmann - Designing Data-Intensive Applications_ The Big Ideas Behind Reliable, Scalable, and Maintainable Systems (2015, O'Reilly Media).pdf>).
- [*Database Internals*](books/database-internals-a-deep-dive-into-how-distributed-data-systems-work.pdf)
  by Alex Petrov: B-trees, write-ahead logging, page cache, and write
  amplification.
- [PostgreSQL's curated book list](https://www.postgresql.org/docs/books/) for a
  current reference when choosing a PostgreSQL performance/operations book.

## 7. Book review and requirements comparison

The four local books answer different parts of the design problem. The two
PostgreSQL books are valuable sources of principles but describe PostgreSQL 9.3-
to-9.6-era behaviour. The other two books are primarily conceptual. None of the
books defines the required HTTP contract or proves that a design will meet the
stated container resource and performance limits.

Current PostgreSQL documentation is the final authority for SQL syntax,
declarative partitioning, JSONB/GIN behaviour, configuration parameters, defaults,
and operational recommendations.

### PostgreSQL for Data Architects

The most relevant material is in the sections on server architecture, physical
design and query execution, data movement, and PostgreSQL's non-relational types.

Useful conclusions:

- Shared buffers work with the operating-system cache; allocating more memory to
  PostgreSQL is not automatically better.
- Checkpoints, WAL, the background writer, and autovacuum are part of the write
  path and can influence latency during sustained ingestion.
- `work_mem` is allocated for individual sort/hash operations, so it must be
  treated as a multiplicative memory setting rather than a server-wide allowance.
- Selectivity and block access determine whether an index is useful. An index may
  be ignored when scanning the table is cheaper.
- `COPY` is the appropriate PostgreSQL-native foundation for high-volume data
  movement.
- JSONB adds processing cost on write in exchange for a binary representation and
  better query/index capabilities.
- Removing old data by removing a time partition avoids the empty space, vacuum
  work, and index bloat caused by a mass `DELETE`.

Version warning: its partitioning example uses table inheritance and an insert
trigger. That implementation must not be copied. The project will use current
declarative range partitioning.

### PostgreSQL 9.6 High Performance

This is the most directly applicable book in the local library. Relevant chapters
cover memory/cache behaviour, configuration, maintenance, benchmarking, indexes,
query optimization, activity statistics, monitoring, partitioning, and bulk
loading.

Useful conclusions:

- Checkpoints can create I/O and latency spikes. WAL size, checkpoint frequency,
  and checkpoint spreading should be observed under the real ingestion workload.
- Configuration examples are workload-specific. The book's sample uses hardware
  far larger than the grading environment, so its numeric values are not defaults
  for this project.
- Autovacuum and statistics are essential to long-term query performance. Rapidly
  loaded partitions may need more deliberate analyze thresholds so plans do not
  rely on poor row-count/selectivity estimates.
- `EXPLAIN (ANALYZE, BUFFERS)` and block statistics are more useful than assuming
  that an index is effective.
- PostgreSQL can combine single-column indexes, but compound indexes can still be
  valuable for exact filter-and-order patterns. Every additional index must prove
  that its read benefit exceeds its ingestion cost.
- Dropping old time partitions is a strong retention strategy. Partition keys must
  appear in query predicates, and excessive partition counts increase planning
  overhead.
- Precreating partitions is safer than creating them from concurrent insert paths.
  Dynamic creation introduces race/deadlock risks, and malformed historical dates
  can create uncontrolled partitions.
- Bulk-loading advice to drop indexes, disable `fsync`, bypass WAL, increase memory
  aggressively, or rebuild constraints applies to an offline initial import. It is
  incompatible with a live API that promises accepted logs are durable and
  immediately queryable.

Version warning: the partitioning chapter uses inheritance, triggers, rules, and
`constraint_exclusion`. Use modern declarative partitioning and partition pruning
instead. Historical configuration names and recommended values must also be
checked against the selected PostgreSQL image.

### Database Internals

The relevant portion is Part I: storage engines, B-trees, transaction processing,
recovery, and log-structured storage. The distributed coordination chapters are
outside the initial single-PostgreSQL design.

Useful conclusions:

- Monotonically increasing keys improve B-tree insertion locality and reduce the
  fragmentation associated with random-key insertion. This supports replacing a
  random UUID with a PostgreSQL identity `BIGINT`.
- A write-heavy service pays for every maintained index. Write amplification
  converts one logical insert into multiple memory, WAL, data-page, and index-page
  writes.
- The RUM trade-off means read cost, update cost, and memory consumption cannot all
  be minimized simultaneously. The resource limit makes an explicit index budget
  necessary.
- WAL and recovery mechanics explain why an HTTP success response must wait for
  a synchronous transaction commit **if the service promises crash-durable
  acknowledgement**; queued or memory-only acceptance does not provide that
  additional guarantee.
- Bulk construction of a fresh index differs from continuously maintaining indexes
  on a live table. Offline bulk-load advantages cannot be assumed during grading.

### Designing Data-Intensive Applications

The most relevant chapters are reliability/scalability, storage and retrieval,
partitioning, transactions, and stream processing.

Useful conclusions:

- Describe load with concrete parameters: logs/second, request batches/second,
  batch size, row width, read/write ratio, aggregation rate, and concurrent clients.
- Report latency distributions rather than averages. The project should record
  p50, p95, and p99 because checkpoint, garbage-collection, lock, and I/O pauses
  appear in the tail.
- B-trees, secondary indexes, and materialized aggregates exchange write cost for
  read performance. This matches the project's conflict between 15,000 logs/second
  and sub-second aggregation.
- PostgreSQL is serving a mixed workload: transaction-like ingestion plus
  analytical time-bucket queries. A row-store can handle one million records, but
  the index and aggregation strategy must be tested under concurrent writes.
- Materialized/rollup aggregates may improve repeated reads, but maintaining them
  makes ingestion more expensive. They remain a measured fallback, not an initial
  assumption.
- The book's distributed partitioning and replicated-log discussions are not the
  same as PostgreSQL table partitioning for retention and should not be applied
  directly.

### Coverage against the project requirements

| Project requirement | What the books contribute | Remaining project work |
| --- | --- | --- |
| Exact `GET /health`, `POST /logs`, `GET /logs`, and `GET /logs/aggregate` contract | No material coverage | Implement and contract-test the supplied paths, validation rules, statuses, and response shapes in TypeScript. |
| Partial validation of ingestion batches | General transaction/error principles only | Preserve original array indexes, commit valid entries together, and report individual rejection reasons. |
| At least 15,000 logs/second | `COPY`, batching, WAL/checkpoint, and write-amplification principles | Prove throughput with the real API, the chosen documented commit configuration, production indexes, and constrained containers; test synchronous durable mode if claiming that added guarantee. |
| Sustained ingestion without dropped accepted requests or crashes | WAL, ACID, transaction commit, and recovery mechanics | Meet the supplied sustained-load behavior. Separately decide whether to adopt the stronger crash-durable-ack policy; if adopted, keep normal WAL and synchronous commit enabled and send success only after commit. |
| Aggregation below one second at p95 | Index/selectivity, statistics, plans, percentiles, and materialized aggregates | Benchmark the exact filters, time buckets, grouping, and concurrent ingestion workload. |
| Searchable within 20 seconds | Transaction visibility and stream-timeliness concepts | Directly commit micro-batches well inside the limit and measure queue plus commit latency. |
| Freely combinable filters | Index combination and query-planner principles | Build parameterized dynamic SQL and test every supported filter combination. |
| Arbitrary attribute equality | Historical JSONB material | Preserve typed JSONB plus a string-normalized search representation if measurements justify it; validate with current GIN documentation. |
| Case-insensitive substring search | Little relevant coverage | Use current `pg_trgm` guidance and measure its GIN index independently because of its write cost. |
| Deterministic cursor pagination | No direct coverage | Use keyset pagination on `(timestamp, id)`, validate opaque cursors, and test equal timestamps. |
| Configurable 30-day retention | Strong rationale for time partitions and dropping old partitions | Use declarative daily partitions, precreate a bounded window, and define handling for already-expired timestamps. |
| Application: 0.5 CPU / 256 MB | General load and percentile concepts | Bound request/queue bytes, minimize parsing/logging overhead, and measure Node memory and GC. |
| PostgreSQL: 1 CPU / 1 GB | Memory, connections, WAL, checkpoints, vacuum, and monitoring principles | Select conservative values and benchmark them; do not copy book configurations. |
| TypeScript implementation and Docker startup | No direct coverage | Use current Node/TypeScript, framework, driver, Docker Compose, migration, and CI sources. |

### Architecture conclusions resulting from the review

1. Use a PostgreSQL identity `BIGINT` as the public log ID and encode it as a JSON
   string. Keep `(timestamp DESC, id DESC)` as the deterministic query/cursor order.
2. Preserve bounded micro-batching into normal WAL-backed tables through `COPY`.
   Under the added crash-durable-ack policy, resolve each waiting HTTP request
   only after the synchronous transaction commits.
3. Establish an index-cost benchmark sequence: ordering index only; add
   service/time; add JSONB GIN; add trigram GIN; finally test both GIN indexes
   together. Record throughput, read latency, WAL bytes, and index size at every
   stage.
4. Use modern declarative daily partitions, created ahead of ingestion. Never run
   old inheritance/trigger/rule examples. Define an explicit path for timestamps
   older than the retention window without creating unbounded partitions.
5. Include planner statistics and autovacuum/analyze thresholds in the performance
   experiment. Test plans both during the rapid million-row load and after analyze.
6. Keep the database connection pool and `work_mem` conservative under 1 GB.
   Measure temporary-file creation before increasing per-query memory.
7. Report p50, p95, and p99 ingestion/aggregation latency together with checkpoint
   spikes, WAL volume, data/index sizes, temporary bytes, buffer hit/read counts,
   CPU, and RAM.
8. Keep rollup tables as a fallback only if direct aggregation misses the p95 target
   after query, statistics, and index tuning.

### Further implementation conclusions

The following refinements make the recommended direction more concrete. They
remain design hypotheses until they are verified by this project's own contract
and load tests.

- A group-commit pipeline is preferable to a fire-and-forget worker: collect
  valid rows from several requests into a bounded batch, `COPY` it inside one
  transaction, and resolve every affected request only after that transaction
  commits. A hard pending-row **and byte** limit is still needed for a database
  outage. The recommended added overload policy is `503` with `Retry-After`
  rather than retaining unbounded data in the 256 MB application container;
  the supplied brief does not prescribe that exact status/header pair.
- If an aggregate rollup is introduced, write its counter changes in the same
  transaction as the raw rows so it cannot permanently diverge after a failed
  batch or retry. Give every rollup table its own retention policy. A raw-table
  partition drop alone must not leave old rollup counts queryable forever.
- A one-second `(timestamp, service, level)` rollup can make arbitrary
  time-range edges exact while serving whole seconds from compact counts. It is
  not a default: high service cardinality can make it nearly as large and
  write-intensive as the raw log table. Direct aggregation is the baseline;
  add a rollup only when measured p95 requires it.
- Do not silently send late or historical records to a default partition that
  is exempt from normal partition pruning and retention drops. Pre-create the
  permitted historical window, reject records outside a documented window, or
  implement a bounded explicit historical-partition policy. The chosen path
  must ensure every accepted record has the same retention guarantee.
- If adopting the added crash-durable-ack policy, keep durability end-to-end:
  normal WAL-backed tables, `fsync` enabled, and `synchronous_commit=on` for
  accepted batches. A database `COMMIT` response with asynchronous commit can
  still lose recently acknowledged data in a crash.
- Separate the scarce database capacity by role: a small write pool for the
  `COPY` pipeline, a bounded read pool with a server-side statement timeout,
  and a small maintenance/health pool. This protects ingestion and liveness
  from slow user queries. Under one PostgreSQL CPU, a large read pool merely
  creates CPU and memory contention; start with only a few read connections.
- Treat `work_mem` as per-operation, per-backend memory, not a server-wide
  allocation. Keep it low initially and measure temporary files before raising
  it. Avoid configuration justifications based on host CPU-count detection;
  normal Node HTTP and PostgreSQL socket I/O do not become faster merely by
  increasing application threads.
- Strict input parsing is part of resource safety and contract correctness:
  enforce maximum body, batch, field, attribute-count, and rejection-response
  sizes; validate timestamps as the documented ISO-8601 form; parse limits and
  cursor IDs strictly rather than accepting numeric prefixes, decimal IDs, or
  permissive date strings.
- Keeping aggregation counters as `BIGINT` through SQL is sensible production
  hardening, not a necessity at the brief's roughly one-million-row test scale.
  If counts can exceed JavaScript's safe-integer range, define an explicit JSON
  string/number representation so the API does not silently lose precision.
- Preserve the useful parts of manual `COPY` preparation: validate before
  enqueueing, escape the selected `COPY` format correctly, avoid unnecessary
  object copies on the ingestion hot path, and keep SQL construction separated
  from HTTP handlers. These optimizations are secondary to correctness and
  must be covered by tests for unusual strings, equal timestamps, failed
  batches, shutdown draining, and backpressure.

## 8. Before implementation begins

1. Use Express as the supplied-brief baseline. Prototype another HTTP framework
   only to support an explicitly accepted and documented deviation.
2. Obtain or recreate the evaluator's batch sizes, timestamp distribution, query
   mix, and payload sizes; they control every meaningful performance decision.
3. Decide and document the policy for legitimate logs older than retention.
4. Define the request-size/backpressure contract so that fixed container memory is
   protected without surprising the required load generator.
5. Verify every PostgreSQL 9.x book recommendation against the current official
   documentation and the exact PostgreSQL Docker image selected for the project.
6. Build the staged index benchmark described above and retain the SQL plans and
   measurements for each configuration.
7. Build a reproducible end-to-end benchmark that records throughput, p50/p95/p99
   ingestion and query latency, CPU/RAM, WAL volume, checkpoint behaviour,
   temporary-file usage, data/index size, buffer activity, and query plans before
   adding optional features.
8. If considering a rollup, benchmark its raw-write, index, WAL, autovacuum, and
   retention costs against direct aggregation before committing to it.
9. Add crash/restart and database-stall tests that prove acknowledged records,
   retention behaviour, queue bounds, and graceful shutdown match the documented
   durability contract.

## 9. Research-derived design rules — pitfalls to avoid

The following rules synthesize the most relevant failure modes identified
during the requirements review, PostgreSQL study, and architecture comparison.
They are design recommendations for the future implementation. Claims that
depend on workload shape or performance remain hypotheses until reproduced by
this project's own tests under the stated Docker limits.

### 9.1 Durability

- The supplied brief does not explicitly define crash-durable acknowledgement.
  The following rules implement the **stronger production contract chosen by
  this R&D**; label them as added guarantees in the final README and tests.
- Keep `fsync`, WAL, and `synchronous_commit=on` for acknowledged batches when
  claiming crash-durable acknowledgement.
  Any configuration that weakens commit durability — `synchronous_commit=off`,
  unlogged tables, asynchronous commit — invalidates that added "200 only after
  a durable commit" contract. A throughput gain under such a setting must not be
  presented as durable. If evaluated experimentally, isolate it from the chosen
  production configuration and document the trade-off honestly.
- Every configuration comment must describe the design that actually exists.
  A setting justified by an architecture that has since been replaced (for
  example an ack-before-durable buffer that no longer exists) is a trap for
  future maintenance and design review.
- Keep exactly one visible source of truth for PostgreSQL tuning, preferably
  the compose service command line. Avoid mixing it with application-driven
  `ALTER SYSTEM` or asynchronous per-connection setup, because configuration
  can then fail, race startup queries, or become contradictory across files.

### 9.2 Partitioning and retention

- Pre-create partitions across the whole live window — the full retention
  window of past days plus a small future window — before traffic arrives, or
  define and document an explicit alternative policy (reject outside-window
  timestamps, or implement a bounded historical-partition policy). Silently
  letting historical rows accumulate in a `DEFAULT` partition can defeat
  partition pruning and retention. Because the brief describes approximately
  one month of data, the benchmark must include backdated timestamps.
- Every pre-aggregated table needs its own retention policy, executed in the
  same maintenance job that drops raw partitions. Dropping raw partitions must
  never leave old rollup counts queryable forever.
- A `DEFAULT` partition, if kept as a safety net, must be monitored (row
  count) and treated as a defect whenever it is non-empty.

### 9.3 Validation must mirror database constraints

- Every column constraint is also a validation rule, enforced per entry
  before enqueueing. A single entry that passes API validation but fails a
  database constraint (column length, control characters, an unparsable
  timestamp) aborts the entire group-commit transaction and rejects every
  valid entry in the same batch — a direct violation of the
  partial-acceptance contract.
- Reject control characters the database cannot store (for example `\u0000`):
  JSON permits them, PostgreSQL `text` does not.
- Normalize each timestamp exactly once, at validation time, to a canonical
  ISO-8601 UTC string, and use that same string for the COPY row, the rollup
  bucket, and the pagination cursor. Do not let JavaScript and PostgreSQL parse
  ambiguous zone-less forms independently; require an explicit offset and
  verify that both layers use the same normalized instant.

### 9.4 Query correctness

- Literal substring search must not treat user input as a pattern. Escape
  `%`, `_`, and `\` (or use a position-based match), otherwise a query like
  `q=100%` matches everything.
- Validate cursors strictly. Accepting scientific notation, empty IDs, or any
  string that passes a loose JavaScript numeric check but fails a `bigint`
  cast turns a `400` into a `500`.
- Parse `limit` strictly (no numeric prefixes), matching the documented input
  contract.
- Prefer aggregation counters as `BIGINT` for production headroom. A 32-bit cast
  is sufficient for the supplied roughly one-million-row dataset but becomes an
  overflow risk at larger retention volumes. Define how BIGINT values are encoded
  in JSON when they may exceed JavaScript's safe-integer range.

### 9.5 Benchmarks and evidence

- Never hardcode time ranges in benchmark scripts. Derive `since`/`until`
  from the data being measured — a hardcoded window goes stale, silently
  measures an empty range, and reports meaningless millisecond latencies.
- The batch size the shipped benchmark drives must be the batch size the
  reported numbers were measured at. A performance table is only credible if
  the repository's own scripts can reproduce it.
- Benchmarks must include backdated timestamps. A generator that only sends
  "now" never exercises the partition-window or retention code paths.

### 9.6 Operations

- Liveness checks must not share a pool with DDL. A long-running
  `DETACH ... CONCURRENTLY` or migration must not queue `/health` behind it.
  Give every pool an explicit acquire timeout so saturation fails fast
  instead of hanging.
- Use a restart policy that survives a process abort; a single heap abort
  must not leave the service dead for the remainder of a run.
- Do not publish the database port to the host and do not ship hardcoded
  credentials — keep the attack surface minimal even in a demo posture.
- Keep a `.dockerignore` that excludes `node_modules` and `.git` from the
  build context; otherwise a local install silently bloats the context and
  cache-busts every build.
- Parse environment variables strictly. `Number(x) || default` silently
  replaces `0` (and any garbage) with the default.

### 9.7 Submission hygiene

- Check `.gitignore` before committing. A broad pattern (for example `*.md`)
  can exclude files the spec explicitly requires (the README). Verify what a
  clean clone actually contains — the submission is the repository, not the
  working tree.
- Every documented claim that names a current default or architecture must be
  updated when the code changes. A stale limitations section that contradicts
  the headline results reads as a contradiction, not as history.

### 9.8 Prototype-pollution protection

- If the JSON parser's prototype-pollution guards are disabled for CPU
  reasons, the safety invariant that makes that acceptable — parsed input is
  never merged into existing objects — must be written down and covered by a
  test, because it is the only thing standing between the current code and a
  future merge that re-opens pollution.

## 10. Candidate best practices for implementation

These patterns currently offer a strong candidate design for the requirements
and resource envelope. Items involving crash-durable acknowledgement or a
specific overload status are added production policies, not evaluator wording.
Optional performance structures must earn their place through reproducible
benchmarks.

1. **Group-commit acknowledgement.** Resolve an ingest request only after the
   transaction carrying its rows commits. "Accepted" and "persisted" are the
   same by construction, and memory is bounded by in-flight request
   concurrency rather than a guessed buffer constant.
2. **Bounded batching with explicit backpressure.** Hard row *and* byte
   ceilings on queued work. Under the recommended overload policy, respond
   `503` + `Retry-After` when full—never a false `200` for uncommitted rows and
   never a `400` for server-side saturation. The exact status/header pair is an
   added contract to document and test.
3. **Transactional rollup, if required.** If pre-aggregated counters are added,
   update them in the same transaction as the raw `COPY` so committed raw data
   and counts remain consistent. Sorting upsert rows by key gives concurrent
   transactions a consistent lock order and reduces deadlock risk.
4. **Fine-grained rollup candidate.** A one-second rollup is worth testing
   because the exposed buckets are exact multiples of a second and arbitrary
   range edges can be answered from small raw slices. Its cardinality, write
   amplification, `fillfactor`, and autovacuum behaviour must be measured
   before it becomes part of the baseline design.
5. **Split connection pools by role.** A small write pool with an acquire
   timeout, a read pool with a server-side `statement_timeout` (an abandoned
   HTTP request does not cancel its PostgreSQL query), and a separate
   DDL/health pool without a statement timeout so retention and liveness never
   queue behind user traffic.
6. **Parameterized SQL everywhere.** Interpolated identifiers (JSON attribute
   keys, `group_by` columns) are validated against an allow-list in both the
   HTTP layer and the SQL-building layer, never trusted from the caller.
7. **Keyset pagination on `(timestamp DESC, id DESC)`** with a `limit + 1`
   probe row. The cursor is anchored to the last row actually returned — never
   the probe — and its timestamp is rendered at microsecond precision by
   PostgreSQL, not truncated by a JavaScript `Date`.
8. **Correct `COPY` text-format escaping.** Single-pass regex, a cheap
   test-before-replace on the hot path, and a non-global regex for the
   `.test()` probe (global regexes advance `lastIndex` and alternate).
9. **Ordered graceful shutdown.** Stop accepting → drain the pipeline →
   close pools, idempotent across repeated signals, bounded by a hard timeout
   so a stuck database cannot hang the process forever.
10. **Runtime settings sized for the container.** Keep the V8 heap cap below
    the cgroup memory limit and leave room for native buffers, request bodies,
    sockets, and driver state. Do not tune `UV_THREADPOOL_SIZE`, V8 worker
    flags, or PostgreSQL parallelism from CPU-count assumptions alone; profile
    the actual constrained container and change one setting at a time.
11. **Error mapping that distinguishes client faults from server
     conditions.** `400` only for genuinely invalid input; statement timeouts,
     pool exhaustion, and backpressure use `503` + `Retry-After` under the
     recommended overload policy so saturation is never misreported as client
     error volume.
12. **CI for the zero-config contract.** Build, typecheck, and run unit tests,
    followed by a compose-up contract smoke test covering every required
    endpoint with mixed valid/invalid input and reliable teardown on failure.
13. **Measurement discipline.** Report p50/p95/p99, change one variable at a
    time, and never benchmark an empty range.

## 11. Additional ideas to consider

- Extract one validation module that owns both the API contract and the
  database constraints (lengths, charset) so the two can never drift; the
  route handler and the SQL layer both call it.
- Add a property-style round-trip test for the COPY serialization: serialize
  a log entry, parse the TSV back, assert equality — it covers escaping edge
  cases (tabs, newlines, backslashes, Unicode) that unit tests miss.
- Track schema changes in a migration version table instead of relying purely
  on idempotent `IF NOT EXISTS` DDL, so removed objects (old indexes,
  superseded tables) converge provably on restart.
- Add a read-after-write freshness check to the contract test: ingest, then
  poll `GET /logs` until the row is visible, asserting the 20-second
  freshness bound.
- The planned `GET /metrics` endpoint should expose pipeline statistics —
  pending rows, committed batches, retries, flush latency — with no
  high-cardinality labels or values.
- Document the database-stall path in the runbook: what the client sees
  under the chosen overload policy (`503` + `Retry-After`), what the operator
  sees (bounded memory, retry loop), and how the service recovers when
  PostgreSQL returns.
- When the rollup table gains its retention cleanup, batch the deletes per
  day rather than issuing one giant `DELETE` — the same reasoning that drives
  partition drops.

## 12. Throughput and latency — requirements and hypotheses

This section translates the brief into concrete performance experiments. The
acceptance thresholds come from the project requirements; architectural and
tuning statements are research hypotheses until the repository contains a
reproducible benchmark, raw results, and resource measurements that support
them.

### 12.1 Validate sustained throughput

- The pipeline must hold the required target for the complete measurement
  window, not merely reach it briefly. Exercise steady load and, where the
  evaluator uses them, stress ramps, spikes, and breakpoint tests so queue
  growth or throughput decay cannot hide behind an average.
- Compare per-request multi-row `INSERT` with a bounded `COPY FROM STDIN`
  group-commit pipeline under the same workload. PostgreSQL's bulk-ingestion
  model makes `COPY` the leading candidate, but the final document must report
  this project's own sustained throughput and latency rather than importing a
  ratio from another environment.

### 12.2 Validate read-after-write visibility

- Newly accepted records must become queryable within the stated freshness
  window during active ingestion. Record the visibility success rate and
  delay distribution. Group commit should make rows visible when success is
  returned, but that property still needs an end-to-end test through the read
  API.

### 12.3 p95 latency decides thresholds

- Scenarios pass or fail on p95, not average. Ingestion p95 must stay in the
  documented acceptance range while the throughput target is sustained.
  Record p50 and p99 as diagnostic context rather than inventing an ingestion
  latency threshold that the brief does not state.
- Aggregate p95 must remain below the brief's one-second target during active
  ingestion. Tens of milliseconds would provide useful headroom, but it is not
  a stated requirement. Test direct partitioned SQL first, then compare indexes,
  a database rollup, and any bounded cache if the direct path misses the target.

### 12.4 Every required endpoint must exist

- An unimplemented endpoint forfeits correctness points outright. Implement
  every required endpoint even in naive form first; optimise after.

### 12.5 Operational acceptance remains part of correctness

- Zero-config startup, health checks, migration order, clean shutdown, and
  restart safety are part of the deliverable, not secondary polish. Verify them
  in the same clean-compose workflow used for contract testing.

### 12.6 Resource envelope: headroom is the design goal

- No universal CPU percentage should be assumed in advance. The implementation
  should stay below both memory limits without repeated garbage-collection or
  database-memory pressure and should retain enough CPU headroom for concurrent
  reads, checkpoints, autovacuum, and short traffic spikes.

### 12.7 Read headroom is part of the throughput budget

- Concurrent read checks run while ingestion is at full rate. If the
  database saturates on the write path, read-after-write success collapses
  and the visibility checks fail. Deliberately leave database CPU headroom
  for reads and measure both paths together rather than optimizing ingestion
  in isolation.
- Fast acceptance must be paired with a read path fast enough to verify it
  within the freshness window. Accepting faster than the read path can prove
  visibility backfires: every accepted row must be queryable quickly, not
  just eventually.

### 12.8 Batch and recent-aggregate experiments

- Compare fixed batch triggers (entry count, byte budget, and maximum delay)
  with a simple adaptive strategy at the target offered rate. Prefer the
  simplest configuration that repeatedly meets throughput, p95 latency, memory,
  and freshness requirements; do not claim an order-of-magnitude advantage
  without retained results.
- A bounded in-process recent-window aggregate cache is an optional experiment,
  not the default architecture. It may reduce recent-query latency, but it also
  consumes application memory, needs startup hydration, and creates recovery and
  consistency questions. PostgreSQL remains authoritative, and a database
  rollup is the less volatile comparison candidate.

### 12.9 Treat read-path correctness as an independent gate

- Throughput cannot compensate for incorrect pagination or query results. Treat
  full-dataset read correctness as an independent acceptance gate.
- Avoid building this pagination cursor from a JavaScript `Date` when PostgreSQL
  values may contain sub-millisecond precision. `Date` preserves milliseconds,
  so converting a higher-precision database timestamp can change the key and
  may skip rows that share the truncated millisecond. This is a conditional
  precision bug, not an inevitable failure for every `Date` value. For this
  design, preserve the database's exact cursor value—for example, render the
  timestamp at full precision in PostgreSQL
  (`to_char(timestamp AT TIME ZONE 'UTC', '...US...')`).
- Verify pagination at full dataset scale before submission: ingest more
  than a million rows and walk the cursor to the end, asserting
  `next_cursor` only becomes null at the true end of the data. Compare the
  complete cursor walk against a trusted database count for the same filters.
- Read headroom in the database buys nothing if the read path itself is
  wrong: CPU headroom prevents contention, it does not fix correctness.
