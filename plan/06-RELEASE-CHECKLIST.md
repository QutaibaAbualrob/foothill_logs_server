# Release Checklist

Run at H+5:30. Nothing here is optional, and several items are irreversible once
pushed — work through it in order.

---

## 1. Content gate — blocking

The repository root is the deliverable. Everything tracked will be read by
someone else, so review what is actually in it rather than what you meant to put
in it.

### 1.1 Automated checks

```bash
# A. The tracked file list is short — read all of it
git ls-files

# B. Nothing unintended has ever been committed
git log --all --name-only --pretty=format: | sort -u

# C. Scratch and build directories are ignored, and the Docker build
#    context excludes them too
git status --ignored --porcelain | head -40
cat .dockerignore
```

Run the detailed pre-push review before this gate is considered green.

### 1.2 Manual review

| File | Look for |
| --- | --- |
| `README.md` | any figure not produced by a script in this repository |
| `src/**/*.ts` comments | every constant, default, and comment must state the engineering purpose it serves |
| `src/db/migrations/*.sql` | index comments state the access pattern they serve, in general terms |
| `docker-compose.yml` | environment variable names and values read as engineering configuration |
| `plan/*.md` | all reasoning attributed to `search_rnd/RND.md`, the specification, PostgreSQL documentation, and our own measurements |
| commit messages | same rule; check with `git log --oneline --all` |

### 1.3 Rule of thumb

Every file in the repository should read as though it were written by an
engineer who studied the specification, the research notes in `search_rnd/`, and
the PostgreSQL documentation — because that is what it is. If a line only makes
sense to someone who has seen material that is not in this repository, rewrite
the line.

---

## 2. The tracked PDF library

`search_rnd/books/` holds roughly 59 MB of copyrighted PDFs, and they are in Git
history — so `git rm` alone will not remove them from what gets pushed. Two
problems: repository weight, and republishing copyrighted books.

**Recommended:** keep the citations, drop the files.

```bash
# 1. Stop tracking them
git rm -r --cached search_rnd/books
printf 'search_rnd/books/\n' >> .gitignore

# 2. Remove them from history (choose one)
#    Preferred, if available:
git filter-repo --path search_rnd/books --invert-paths
#    Fallback — collapse to a single clean initial commit, then build
#    incrementally on top of it during the remaining phases:
git checkout --orphan clean-main && git add -A && git commit -m "..." \
  && git branch -D main && git branch -m main
```

3. Update `search_rnd/RND.md`: replace the file links with plain citations
   (title, author, edition). Citing a book is normal and correct; shipping the
   PDF is not.

**Verify:** `git count-objects -vH` shows a small pack, and
`git log --all --name-only --pretty=format: | grep -i '\.pdf$'` prints nothing.

---

## 3. Repository hygiene

| Check | Command / criterion |
| --- | --- |
| README is tracked and not ignored | `git check-ignore -v README.md` finds no rule; `git ls-files README.md` prints it |
| No ignore pattern excludes a required file | review `.gitignore` line by line — a broad pattern such as `*.md` would silently drop the README |
| No build output tracked | `git ls-files \| grep -E '^(dist/\|node_modules/)'` prints nothing |
| No `.env` tracked | `git ls-files \| grep -E '(^\|/)\.env$'` prints nothing |
| `.env.example` present | documents every variable, with safe defaults |
| No credentials in source | compose environment only; nothing baked into the image |
| Database port not published to the host | `docker-compose.yml` exposes only the application |
| Compose at the repository root | `docker compose up` needs no `-f` and no `cd` |
| CI at `.github/workflows/` from the root | and green on the pushed commit |
| Commit history | incremental, meaningful messages; the build is not one giant commit |
| Repository size | `git count-objects -vH` — small |

---

## 4. README outline

Spec §40 lists the required sections. Structure it this way and fill each with
real content.

```text
# <name>
one-paragraph description; what it does and the shape of the design

## Quick start
docker compose up  → healthy; curl examples for all four endpoints

## Configuration
every env var, its default, and what it controls
explicit statement: zero-config `docker compose up` gives the plain core service

## API
/health, POST /logs, GET /logs, GET /logs/aggregate
request and response examples; validation rules; error format; status codes

## Architecture
data-flow diagram; module layering; why group commit; what a 200 means

## Database design
schema; why BIGINT identity over UUID; why (timestamp, id) is the primary key;
why range partitioning; the attribute storage strategy and its trade-offs

## Indexes
one subsection per shipped index: what it serves, the query pattern, the
EXPLAIN evidence, and its ingestion cost
also: which indexes we deliberately did NOT ship, and why

## Cursor pagination
keyset design; why the cursor carries the exact database-rendered timestamp;
filter binding; what makes next_cursor null

## Retention
configuration; how expiry is detected; partition drop plus bounded boundary
sweep; rollup expiry; schedule; performance considerations

## Durability
what a 200 guarantees under each profile; the default and its trade-off;
how to switch profiles — stated plainly, with no overclaim

## Performance
environment; dataset; batch size; methodology; how to reproduce;
throughput, p50/p95/p99, aggregate latency, cursor page latency and drain
throughput, freshness, CPU, memory, WAL, index sizes
bottlenecks found and the optimisation applied to each — with before/after

## Testing and CI
what unit tests cover; what the contract smoke covers; what CI runs

## Known limitations
honest, specific, and consistent with the Performance section

## Optional features
per feature: name, default state, env vars, how to enable and disable,
and confirmation that default `docker compose up` remains contract-compatible
```

**Consistency check before commit:** every default named in the README matches
the code, and the Limitations section does not contradict the Performance
section. A stale limitation reads as a contradiction, not as history.

---

## 5. Definition of Done — spec §46

Tick honestly. An unticked box is information; a falsely ticked one is a defect.

- [ ] `docker compose up` starts the complete system
- [ ] PostgreSQL migrations run automatically
- [ ] `/health` becomes healthy only after the application is ready
- [ ] `POST /logs` supports batches
- [ ] Per-entry validation works
- [ ] Invalid entries do not reject valid entries
- [ ] `GET /logs` supports all required filters
- [ ] Filters can be freely combined
- [ ] Cursor-based pagination works
- [ ] Pagination ordering is deterministic
- [ ] `GET /logs/aggregate` works
- [ ] All required bucket sizes work
- [ ] Grouping by service works
- [ ] Grouping by level works
- [ ] Invalid parameters return the required `400` format
- [ ] Retention is implemented and documented
- [ ] Queries are parameterised and protected from SQL injection
- [ ] The system handles approximately 1,000,000 logs
- [ ] Ingestion reaches at least 15,000 logs/sec
- [ ] Aggregation reaches p95 < 1 second
- [ ] Queries remain usable during ingestion
- [ ] Newly ingested logs become queryable within 20 seconds
- [ ] CI passes
- [ ] README is complete
- [ ] Performance has been measured
- [ ] Important queries have been analysed with `EXPLAIN ANALYZE`
- [ ] The architecture can be explained during the demo
- [ ] The 5-minute demo video is prepared

---

## 6. Final push sequence

```bash
# 1. gates
npm run typecheck && npm test && npm run build
docker compose up -d --wait && npm run smoke && docker compose down -v

# 2. pre-push review gate (§1) — must be clean

# 3. commit incrementally, meaningful messages

# 4. push, then verify what actually landed
git clone <remote> /tmp/final && cd /tmp/final
docker compose up -d --wait && curl -sf localhost:8080/health
```

The repository is the deliverable, not the working tree. Confirm what a clean
clone of the pushed remote actually contains before calling it done.

---

## 7. Demo readiness — spec §44

Be able to do each of these live, without notes:

architecture · major technical decisions · schema justification · index
justification · run `EXPLAIN ANALYZE` · ingestion flow · query flow · cursor
pagination · attribute storage strategy · retention strategy · bottlenecks ·
optimisations · debug an issue · extend a feature.

The rule from the specification is that the submitted system must be fully
understandable and explainable by the developer. Before submitting, read every
shipped file once and make sure you can defend it — anything you cannot explain
is a candidate for deletion, not for shipping.
