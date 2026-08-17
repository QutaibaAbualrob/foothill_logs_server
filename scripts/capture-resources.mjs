/**
 * Resource capture (T14).
 *
 * Samples docker stats for the two compose containers concurrently for a
 * fixed wall-clock duration. The Docker CLI's own sampling cadence can be
 * slower than one second, so the summary records actual elapsed time and
 * sample-cycle count. The script creates
 * bench/raw/<RUN_NAME>-resources.csv, then
 * captures PostgreSQL-side evidence — WAL position, table/index sizes, buffer
 * hit ratio — into bench/raw/<RUN_NAME>-summary.json.
 *
 * Run this alongside a scenario, not after it:
 *
 *   RUN_NAME=baseline-load DURATION_SECONDS=60 node scripts/capture-resources.mjs
 *
 * The CSV and JSON are gitignored (bench/raw/); the recorded numbers land in
 * bench/results/*.md by whoever writes up the run.
 */

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const runName = process.env.RUN_NAME ?? `${new Date().toISOString().replace(/[:.]/g, "-")}-resources`;
const durationSeconds = Number(process.env.DURATION_SECONDS ?? 60);
const execFileAsync = promisify(execFile);

/**
 * The sampled containers are resolved from the compose project this capture is
 * running against, never hardcoded. Every other docker call in this file goes
 * through `docker compose exec`, which follows COMPOSE_PROJECT_NAME — so a
 * hardcoded name here does not merely fail, it silently mixes two stacks into
 * one results file: PostgreSQL's WAL and size evidence comes from the project
 * under test while the CPU and RSS columns come from whichever project happens
 * to own the hardcoded name. Bring a second stack up beside the shipped one —
 * which is how a runtime or framework branch gets measured — and the run reports
 * the other stack's CPU as its own.
 */
function resolveContainers() {
  return ["api", "postgres"].map((service) => {
    const id = execFileSync("docker", ["compose", "ps", "-q", service], { encoding: "utf8" })
      .trim()
      .split(/\r?\n/)[0];
    if (!id) {
      throw new Error(
        `no running '${service}' container in this compose project; ` +
          "set COMPOSE_FILE / COMPOSE_PROJECT_NAME to the stack under test",
      );
    }
    return id;
  });
}

if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runName)) {
  throw new Error("RUN_NAME must contain only letters, digits, dots, underscores, and hyphens");
}
if (!Number.isInteger(durationSeconds) || durationSeconds < 1) {
  throw new Error("DURATION_SECONDS must be a positive integer");
}

// Sampled by id, reported by name: the id is what cannot be claimed by another
// project, the name is what a reader of the summary needs.
const containers = resolveContainers();
const containerNames = containers.map((id) =>
  execFileSync("docker", ["inspect", "-f", "{{.Name}}", id], { encoding: "utf8" }).trim().replace(/^\//, ""),
);

const repoRoot = process.cwd();
const rawDir = join(repoRoot, "bench", "raw");
mkdirSync(rawDir, { recursive: true });
const csvPath = join(rawDir, `${runName}-resources.csv`);
const summaryPath = join(rawDir, `${runName}-summary.json`);

if (existsSync(csvPath) || existsSync(summaryPath)) {
  throw new Error(`RUN_NAME already exists; choose a new name: ${runName}`);
}

async function dockerStatsJson(container) {
  const { stdout } = await execFileAsync("docker", ["stats", "--no-stream", "--format", "json", container], {
    encoding: "utf8",
  });
  const lines = stdout.trim().split(/\r?\n/);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null) return parsed;
    } catch {
      // skip non-JSON stderr noise
    }
  }
  throw new Error(`docker stats returned no JSON for ${container}`);
}

function psql(service, sql) {
  return execFileSync(
    "docker",
    ["compose", "exec", "-T", service, "psql", "-U", "logger", "-d", "logs", "-tAc", sql],
    { encoding: "utf8" },
  ).trim();
}

writeFileSync(
  csvPath,
  "ts,container,cpu_percent,mem_usage,mem_percent,net_io,block_io,pids\n",
  { flag: "wx" },
);

const startedAt = new Date();
const deadlineAt = startedAt.getTime() + durationSeconds * 1000;
let sampleCycles = 0;

while (Date.now() < deadlineAt) {
  const ts = new Date().toISOString();
  const samples = await Promise.all(containers.map((container) => dockerStatsJson(container)));
  for (const stats of samples) {
    const fields = [ts, stats.Name, stats.CPUPerc, stats.MemUsage, stats.MemPerc, stats.NetIO, stats.BlockIO, stats.PIDs];
    appendFileSync(csvPath, `${fields.map((field) => `"${String(field).replaceAll('"', "'")}"`).join(",")}\n`);
  }
  sampleCycles += 1;
  const nextSampleAt = Math.min(startedAt.getTime() + sampleCycles * 1000, deadlineAt);
  const delayMs = nextSampleAt - Date.now();
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

const endedAt = new Date();

const walLsn = psql("postgres", "SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0');");
const sizes = JSON.parse(
  psql(
    "postgres",
    `WITH log_relations AS (
       SELECT relid FROM pg_partition_tree('logs'::regclass)
     ), all_index_relations AS (
       SELECT relid FROM log_relations
       UNION ALL
       SELECT 'logs_agg_1m'::regclass
     ), measured AS (
       SELECT
         (SELECT COALESCE(sum(pg_total_relation_size(relid)), 0) FROM log_relations) AS logs_total,
         pg_total_relation_size('logs_agg_1m') AS rollup_total,
         (SELECT COALESCE(sum(pg_indexes_size(relid)), 0) FROM all_index_relations) AS indexes_total
     )
     SELECT json_build_object(
       'logsTotalBytes', logs_total::text,
       'logsTotalSize', pg_size_pretty(logs_total),
       'rollupTotalBytes', rollup_total::text,
       'rollupTotalSize', pg_size_pretty(rollup_total),
       'indexBytes', indexes_total::text,
       'indexSize', pg_size_pretty(indexes_total)
     )::text
     FROM measured;`,
  ),
);
const buffers = psql(
  "postgres",
  "SELECT blks_hit || '/' || (blks_hit + blks_read) FROM pg_stat_database WHERE datname = 'logs';",
);

writeFileSync(
  summaryPath,
  JSON.stringify(
    {
      runName,
      durationSeconds,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      elapsedSeconds: Number(((endedAt.getTime() - startedAt.getTime()) / 1000).toFixed(3)),
      sampleCycles,
      containers: containerNames,
      postgres: {
        walLsnOffsetBytes: walLsn,
        ...sizes,
        bufferHits: buffers,
      },
    },
    null,
    2,
  ),
  { flag: "wx" },
);

console.log(`resources: ${csvPath}`);
console.log(`summary: ${summaryPath}`);
