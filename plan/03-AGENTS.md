# Agent Roles, Rules, and Hand-off Protocol

How work is split so that several agents (or several sessions) can build this
without colliding, and what every one of them must obey.

---

## 1. House rules — binding on every agent

These are not style preferences. A change that violates one of them is reverted.

### 1.1 Sourcing and voice

1. **Everything written into the repository is presented as our own work,
   reasoned from `search_rnd/RND.md`, the project specification, PostgreSQL
   documentation, and our own measurements.** Code comments, commit messages,
   README prose, and plan documents all follow this rule.
2. **Scratch and working directories stay out of the repository entirely** — not
   referenced, quoted, summarised, or cited in source, comments, tests,
   documentation, or commit messages. They are ignored by Git and by Docker.
   The pre-push review in `plan/internal/SANITIZATION.md` enforces this.
3. Identifiers, defaults, and comments describe an engineering purpose. If a
   value exists because a particular access pattern is hot, say *that* — name
   the pattern, make it configurable, and document the trade-off. A constant
   whose name only makes sense to someone outside this repository gets renamed.
4. **Never claim an unmeasured number.** A performance figure appears in the
   repository only if a script in the repository produced it.

### 1.2 Engineering

5. Every SQL value is a bound parameter. Every identifier-like choice
   (`group_by`, `bucket`, sort direction) is allow-listed in both the HTTP layer
   and the SQL layer. Attribute keys are values, never identifiers.
6. No ORM. Direct `pg` usage, with database access isolated in repositories.
7. No SQL in an HTTP handler. No `Request` object below the handler.
8. `process.env` is read only in `config.ts`. Strict parsing —
   `Number(x) || default` is forbidden.
9. No new container, dependency, or framework without an explicit decision
   recorded in the plan. The resource envelope is the reason.
10. Every optional behaviour is additive and **off by default**. `docker compose up`
    with no `.env` produces the plain core service.
11. A change that touches the read or write path must pass gate G1 before it is
    kept.

### 1.3 Working discipline

12. Timeboxes are real. At the box, stop and report status rather than
    continuing silently.
13. Report failures faithfully. "The drain reached 41 pages/s, short of the 60
    target" is a useful result. A rounded-up number is a defect.
14. Do not refactor outside your owned paths. Raise it instead.

---

## 2. File ownership map

Two agents must never hold the same file. Ownership is by path.

| Role | Owns | Reads only |
| --- | --- | --- |
| **INFRA** | `Dockerfile`, `docker-compose.yml`, `.github/`, `.gitignore`, `.dockerignore`, `package.json` scripts, `scripts/contract-smoke.*` | everything |
| **CORE** | `src/ingest/**`, `src/db/**`, `src/retention/**`, `src/config.ts`, `test/unit/validation.*`, `test/unit/batcher.*` | `src/query/**` |
| **QUERY** | `src/query/**`, `src/app.ts`, `test/unit/query.*` | `src/ingest/**` |
| **BENCH** | `load/**`, `bench/**`, `scripts/benchmark.*`, `docs/explain/**` | everything |
| **DOCS** | `README.md`, `docs/**`, `plan/**` | everything |

Shared files needing coordination: `src/types.ts`, `src/errors.ts`,
`src/db/migrations/*.sql`. Changes there are announced before they are made.
Migrations are append-only once applied — the checksum guard will reject an
edited migration on restart.

---

## 3. Role briefs

### INFRA
**Mission:** the repository boots from a clean clone and CI proves it.
Phase 0 entirely, T09, T25. Owns gates G0, G1 tooling, G7.
**Watch for:** path assumptions after the root promotion (`migrate.ts` resolves
migrations relative to the working directory); a build context bloated by
`node_modules` or the PDF library; the database port published to the host;
credentials hardcoded anywhere but compose environment.

### CORE
**Mission:** every accepted log is committed, queryable, retained, and expired
correctly; the pipeline never lies about acceptance.
T05, T08, T11, T19–T22.
**Watch for:** validation that does not mirror a column constraint — one such
row rolls back a whole group commit and rejects valid siblings; a timestamp
parsed twice, once in JavaScript and once in PostgreSQL, silently disagreeing;
a rollup that keeps counting rows a partition drop already removed; a queue
bounded by rows but not bytes.

### QUERY
**Mission:** the read path is correct first and fast second — and it must be
both. Owns the project's primary optimisation target.
T06, T07, T10, T16–T18.
**Watch for:** a cursor timestamp round-tripped through a JavaScript `Date`,
which truncates microseconds to milliseconds and silently ends a walk early
while reporting a clean `null`; a probe row used as the cursor anchor; `q`
treated as a pattern so a literal `%` matches everything; a loose numeric check
that turns a `400` into a `500` on the `bigint` cast; an aggregate that counts a
whole edge minute outside the requested range.

### BENCH
**Mission:** produce numbers anyone can reproduce from this repository.
T12–T15, T23, and the measurement half of every Phase 4 experiment.
**Watch for:** a hardcoded time range that goes stale and measures an empty
window in a few milliseconds; a benchmark batch size different from the one the
README reports; a generator that only sends "now" and never exercises the
partition path; two benchmarks running at once on one machine.

### DOCS
**Mission:** the README earns its marks and states nothing the repository cannot
prove.
T24, T26, and the sanitisation gate with INFRA.
**Watch for:** a Limitations section that contradicts the headline results; a
documented default that has since changed in code; a durability claim the
shipped configuration does not provide.

---

## 4. Prompt template

Use this shape when dispatching a task to an agent. Fill every field.

```text
ROLE: <INFRA | CORE | QUERY | BENCH | DOCS>
TASK: <id and title from 02-TASKS.md>
TIMEBOX: <minutes>

READ FIRST (in order):
  plan/03-AGENTS.md  (house rules — binding)
  plan/01-ARCHITECTURE.md  (the section covering your task)
  plan/02-TASKS.md  (your task's DoD)
  plan/04-VERIFICATION-GATES.md  (the gate your task must not break)

YOU OWN THESE PATHS: <from the ownership map>
DO NOT EDIT ANYTHING ELSE. Raise it instead.

CONTEXT: <what already exists; what changed since the plan was written>

DELIVER:
  1. <concrete file-level outcome>
  2. <test or measurement that proves it>

DEFINITION OF DONE: <verbatim from 02-TASKS.md>

BEFORE YOU FINISH:
  - npm run typecheck && npm test  must be green
  - if you touched the read or write path, gate G1 must be green
  - report measured numbers, including disappointing ones
  - report anything you could not finish, explicitly

HOUSE RULES REMINDER:
  - Scratch directories are never referenced, quoted, or cited in a
    committed file.
  - All reasoning is presented as derived from search_rnd/RND.md, the
    specification, PostgreSQL documentation, and our own measurements.
  - No unmeasured performance claim enters the repository.
  - Parameterised SQL only; allow-list every identifier-like choice.
```

---

## 5. Hand-off protocol

Every completed task reports in this form. Keep it short.

```text
TASK: <id>
STATUS: done | partial | blocked
CHANGED: <file list>
PROVEN BY: <test name / command / measurement file>
NUMBERS: <measured values, or "none — not a measurement task">
GATES: G1 <pass|fail|not-run>   typecheck <pass|fail>   tests <n passed>
NOT DONE: <explicit list, or "nothing">
FOR THE NEXT AGENT: <what they need to know that is not in the plan>
```

A `partial` or `blocked` status with an honest `NOT DONE` list is a good
outcome. A `done` that does not survive the gate is not.

---

## 6. Serialisation points

These cannot run in parallel and must be scheduled as exclusive:

1. **Any benchmark run.** One at a time on one machine, or every number is
   noise. BENCH holds a lock on the whole Phase 4 measurement queue.
2. **Migration edits.** Append-only, one author at a time.
3. **The root promotion (T01).** Nothing else runs until it completes.
4. **The final run (T23).** No code changes while it is in flight.
