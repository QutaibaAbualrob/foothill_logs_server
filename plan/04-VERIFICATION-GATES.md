# Verification Gates

Eight gates, G0–G7. Each is a hard stop: the phase does not end until its gate
is green, or the fallback ladder in `00-MASTER-PLAN.md` §7 is applied and the
shortfall is written down.

Every gate is a command, not an opinion.

---

## G0 — Clean-clone boot · end of Phase 0

```bash
git clone . /tmp/g0 && cd /tmp/g0 && docker compose up -d --wait && curl -sf localhost:8080/health
```

| Check | Pass criteria |
| --- | --- |
| Compose starts from the repository root | no `-f` flag, no `cd`, no `.env` |
| Migrations run automatically | log line confirms; `schema_migrations` populated |
| `/health` | `200`, and only after migrations applied |
| `/health` before ready | not `200` — readiness is real, not hardcoded |
| Build context | under ~5 MB |
| Database port | not published to the host |
| Credentials | none hardcoded in image or source |

---

## G1 — Contract exactness · end of Phase 1, and after every Phase 4 change

`npm run smoke` must exit 0. It asserts:

### `GET /health`
- `200` when ready.

### `POST /logs`
| Input | Expected |
| --- | --- |
| single valid entry | `200`, `accepted: 1`, `rejected: []` |
| batch of valid entries | `200`, `accepted: n` |
| mixed valid and invalid | `200`, valid stored, `rejected` carries **original array indexes** and a reason each |
| all entries invalid | `400` |
| `{"logs": []}` | `400` |
| malformed JSON | `400`, not `500`, process alive |
| missing `logs` key / `logs` not an array | `400` |
| timestamp > 5 min in the future | that entry rejected, siblings accepted |
| nested-object or array attribute value | that entry rejected |

### `GET /logs`
| Input | Expected |
| --- | --- |
| no parameters | `200`, ≤100 logs, `next_cursor` present |
| every filter combined | `200`, results satisfy all filters |
| `limit=1000` | `200`, ≤1000 |
| response shape | `{logs:[{id,timestamp,level,service,message,attributes}], next_cursor}` |
| `id` type | string |
| attribute types | numbers stay numbers, booleans stay booleans |
| ordering | strictly non-increasing by `(timestamp, id)` |
| exhausted result set | `next_cursor` present and exactly `null` |

### `GET /logs/aggregate`
| Input | Expected |
| --- | --- |
| each of `1m`, `5m`, `1h`, `1d` | `200`, buckets ascending by `start` |
| `group_by=service` / `group_by=level` | `200`, `group` populated |
| no `group_by` | `group` is `null` |
| empty range | `200`, `{"buckets": []}` |
| rollup path vs raw path, same filters | identical counts |
| range not aligned to a minute | edge minutes counted only for the requested span |

### Freshness
Ingest a batch, then poll `GET /logs` until it is visible; assert well inside
the 20-second requirement and record the observed delay.

---

## G2 — Reliability matrix · end of Phase 2

Every row returns the stated status, and the process stays alive throughout.

| Request | Expected |
| --- | --- |
| `?limit=abc` / `?limit=50x` / `?limit=1e3` | `400` |
| `?limit=0` / `?limit=1001` / `?limit=-1` | `400` |
| `?since=not-a-date` / `?until=2026-13-45` | `400` |
| `?since=2026-08-02T00:00:00Z&until=2026-08-01T00:00:00Z` | `400` |
| `?level=critical` | `400` |
| `?bucket=7m` / `?group_by=message` | `400` |
| aggregate without `since`/`until`/`bucket` | `400` |
| `?cursor=garbage` / truncated / signature flipped | `400`, never `500` |
| cursor minted under filter A replayed under filter B | `400` |
| `?q=100%` | `200`, literal substring — does **not** match everything |
| `?q=a_b` / `?q=back\slash` | `200`, literal match |
| `?attr.=x` (empty key) | `400` |
| `?service=a&service=b` (duplicated) | deterministic, documented, never `500` |
| SQL-injection strings in `service`, `q`, `attr` key and value | `200` or `400`, never executed, never `500` |
| empty result range | `200` with empty array |
| PostgreSQL stopped mid-run | `503` + `Retry-After`, never `500`, no crash, recovers when it returns |
| queue saturated | `503` + `Retry-After`, never a false `200` |
| `SIGTERM` during ingestion | in-flight batches drain, no acknowledged row lost |
| repeated `SIGTERM` | idempotent, bounded by the shutdown timeout |

Error body is `{"error": "<description>"}` throughout (spec §17).

---

## G3 — Pagination at full scale · during Phase 3, re-checked in Phase 5

The gate that decides read-path credibility. Our research record §12.9 requires
this to be verified at real scale, not on a toy dataset.

1. Ingest **more than one million** rows, including deliberately tied timestamps
   and sub-millisecond spacing.
2. Walk the cursor from the first page to the end, with no filters.
3. Assert:
   - `next_cursor` becomes `null` **only** at the true end;
   - the count of unique ids walked equals `SELECT count(*)` for the same
     filters — exactly;
   - no id appears twice;
   - no id is skipped;
   - the walked sequence is monotonically non-increasing by `(timestamp, id)`.
4. Repeat the walk under a `service` filter and under a hot-attribute filter,
   each cross-checked against its own trusted count.

**Failure signature to watch for:** a visible-count that flatlines at the same
number across runs with different data volumes. That is early pagination
termination — almost always a cursor key that lost precision — not slow reads.

---

## G4 — Aggregate correctness · end of Phase 1

| Case | Assertion |
| --- | --- |
| Rollup path vs raw path | identical counts for the same filter set |
| Unaligned `since`/`until` | edge minutes contribute only their in-range portion |
| `q` present | raw path used; counts match a direct `SELECT count(*)` |
| `attr.<key>` present | raw path used; counts match |
| `5m` / `1h` / `1d` | equal the sum of their constituent minutes |
| Grouped totals | sum to the ungrouped total for the same range |
| After a retention cycle | dropped raw data no longer appears in aggregates |
| Counts near 2³¹ | `BIGINT` throughout, no wraparound, JSON representation defined |

---

## G5 — Performance · baseline in Phase 3, final in Phase 5

From the compose stack with the caps applied (application 0.5 CPU / 256 MB,
PostgreSQL 1 CPU / 1 GB).

| Metric | Requirement | Plan target |
| --- | --- | --- |
| Sustained ingestion | ≥15,000 logs/s (spec §21) | ≥15,000 with margin, sustained for the full window, not a peak |
| Dropped accepted requests | zero (spec §21) | zero |
| Application crashes | zero | zero |
| Aggregate p95 during ingestion | <1 s (spec §24) | double digits in ms |
| Freshness | queryable <20 s (spec §21) | sub-second, since acknowledgement follows commit |
| Aggregate request rate during ingestion | ≥1/s (spec §21) | sustained |
| Stored volume | ~1,000,000 rows (spec §21) | verified at >1 M |
| **1,000-row page, end to end** | not specified | **≤8 ms p95** — the plan's primary target |
| **Drain walk** | not specified | **completes to the true end inside the window; ≥60 pages/s, target ≥100** |
| Application RSS | <256 MB | with headroom; no restart |
| PostgreSQL CPU during ingestion | — | headroom deliberately left for concurrent reads |

Recorded for every run: p50 / p95 / p99, throughput, error rate, application and
PostgreSQL CPU and memory, WAL growth, table and index sizes, buffer hit ratio,
temporary-file bytes, pool wait time.

**Honesty rule:** a target that is missed is written down as missed, in the
README's Limitations section, with the measured number.

---

## G6 — Evidence quality · end of Phase 5

| Check | Pass criteria |
| --- | --- |
| Every README figure | traceable to a file under `bench/results/` |
| Shipped benchmark scripts | reproduce the README's numbers |
| Benchmark batch size | identical to the batch size the README reports |
| Time ranges | derived from the data present, never hardcoded |
| Backdated timestamps | present in the generator |
| `EXPLAIN (ANALYZE, BUFFERS)` | captured for every index we claim is used |
| Every shipped index | justified by a captured plan that actually uses it |
| Unused index | removed before submission |
| One variable per experiment | the experiment log shows it |

---

## G7 — Submission · end of Phase 6

Full checklist in `06-SUBMISSION-CHECKLIST.md`. The blocking subset:

```bash
# 1. Only intended files are tracked — review the whole list, it is short
git ls-files

# 2. The required README is actually tracked and not excluded by any rule
git check-ignore -v README.md   # must find no rule
git ls-files README.md          # must print README.md

# 3. No scratch directories, build output, environment files, or large
#    binaries in the tree or anywhere in history
git log --all --name-only --pretty=format: | sort -u
git count-objects -vH           # pack must be small

# 4. A fresh clone of the pushed remote boots
git clone <remote> /tmp/g7 && cd /tmp/g7 && docker compose up -d --wait && curl -sf localhost:8080/health
```

| Check | Pass criteria |
| --- | --- |
| Definition of Done (spec §46) | every box ticked, honestly |
| README | every section spec §40 requires |
| CI | green on the pushed commit; builds, tests, and runs the contract smoke |
| Commit history | incremental and meaningful |
| Repository size | small; no large binaries in history |
| `docker compose up` from a fresh clone | works with no `.env`, no arguments |
| Limitations | honest, and not contradicted by the results section |
