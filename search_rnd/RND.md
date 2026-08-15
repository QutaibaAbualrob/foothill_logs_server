# R&D Notes: Log Ingestion and Query Service

> Status: concept and research only. No application, Docker, database, or benchmark
> implementation exists yet. This document is a working record for the final
> TypeScript project; it is not the submission README.

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
  write path. The final HTTP framework is intentionally still open (see section 5).

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
transactions. A request receives `200` only after its valid entries commit; invalid
entries remain reported by their original request index. This removes per-row SQL
round trips while preserving the API's partial-batch behaviour.

The queue must be bounded by both count and estimated bytes. When full, it should
apply explicit backpressure (`503` and `Retry-After`) before claiming any extra
entries were accepted. This is preferable to growing beyond the application's
memory limit or replying `200` for uncommitted data.

Use normal, WAL-backed tables and synchronous commits. Do **not** use an unlogged
staging table or asynchronous commit for acknowledged logs: either can lose data
after a crash even though a request received success.

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
| Durability shortcuts | Turning off `synchronous_commit`, using unlogged tables, or acknowledging queued data can improve a benchmark while violating reliability. | Return success only after a normal PostgreSQL transaction commits. |

Candidate PostgreSQL settings to benchmark, not assume: a modest `shared_buffers`
budget (for example 256 MB), low connection count, appropriate WAL/checkpoint
settings, and JIT disabled for short queries. `fsync` and synchronous commit stay
enabled for accepted records.

## 5. TypeScript implementation choices to research

| Option | Why to consider it | Trade-off |
| --- | --- | --- |
| **Fastify + `pg` + `pg-copy-streams`** | Mature Node server, strong TypeScript support, low overhead, and direct control of `COPY` and query plans. | Adds a framework and requires custom per-entry validation rather than relying only on route schemas. |
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
grader's resource and performance limits.

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
  the transaction commit; queued or memory-only acceptance is not durability.
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
| At least 15,000 logs/second | `COPY`, batching, WAL/checkpoint, and write-amplification principles | Prove throughput with the real API, durable commits, production indexes, and constrained containers. |
| No acknowledged data loss | WAL, ACID, transaction commit, and recovery mechanics | Keep `fsync`, full-page writes, WAL, and synchronous commit enabled; send success only after commit. |
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
   Resolve each waiting HTTP request only after the transaction commits.
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

## 8. Before implementation begins

1. Choose the HTTP framework after a small, comparable prototype or focused study.
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
