/**
 * Resource capture (T14).
 *
 * Samples docker stats for the two compose containers once per second for a
 * fixed duration and appends rows to bench/raw/<RUN_NAME>-resources.csv, then
 * captures PostgreSQL-side evidence — WAL position, table/index sizes, buffer
 * hit ratio — into bench/raw/<RUN_NAME>-summary.json.
 *
 * Run this alongside a scenario, not after it:
 *
 *   RUN_NAME=baseline-load DURATION_SECONDS=60 node scripts/capture-resources.mjs
 *
 * The CSV and JSON are gitignored (bench/raw/); the curated numbers land in
 * bench/results/*.md by whoever writes up the run.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const runName = process.env.RUN_NAME ?? `${new Date().toISOString().replace(/[:.]/g, "-")}-resources`;
const durationSeconds = Number(process.env.DURATION_SECONDS ?? 60);
const composeCmd = process.env.DOCKER_COMPOSE_CMD ?? "docker compose";
const containers = ["server_loger-api-1", "server_loger-postgres-1"];

const repoRoot = process.cwd();
const rawDir = join(repoRoot, "bench", "raw");
mkdirSync(rawDir, { recursive: true });
const csvPath = join(rawDir, `${runName}-resources.csv`);

function dockerStatsJson(container) {
  const lines = execFileSync("docker", ["stats", "--no-stream", "--format", "json", container], {
    encoding: "utf8",
  }).trim().split(/\r?\n/);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null) return parsed;
    } catch {
      // skip non-JSON stderr noise
    }
  }
  return null;
}

function psql(container, sql) {
  return execFileSync(composeCmd, ["exec", "-T", container, "psql", "-U", "logger", "-d", "logs", "-tAc", sql], {
    encoding: "utf8",
  }).trim();
}

appendFileSync(
  csvPath,
  "ts,container,cpu_percent,mem_usage,mem_percent,net_io,block_io,pids\n",
);

for (let second = 0; second < durationSeconds; second += 1) {
  const ts = new Date().toISOString();
  for (const container of containers) {
    const stats = dockerStatsJson(container);
    if (stats === null) continue;
    const fields = [ts, stats.Name, stats.CPUPerc, stats.MemUsage, stats.MemPerc, stats.NetIO, stats.BlockIO, stats.PIDs];
    appendFileSync(csvPath, `${fields.map((field) => `"${String(field).replaceAll('"', "'")}"`).join(",")}\n`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

const walLsn = psql("postgres", "SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0');");
const logsSize = psql("postgres", "SELECT pg_size_pretty(pg_total_relation_size('logs'));");
const rollupSize = psql("postgres", "SELECT pg_size_pretty(pg_total_relation_size('logs_agg_1m'));");
const indexSize = psql(
  "postgres",
  "SELECT pg_size_pretty(COALESCE(sum(pg_relation_size(indexrelid)), 0)) FROM pg_index WHERE indrelid IN ('logs'::regclass, 'logs_agg_1m'::regclass);",
);
const buffers = psql(
  "postgres",
  "SELECT blks_hit || '/' || (blks_hit + blks_read) FROM pg_stat_database WHERE datname = 'logs';",
);

writeFileSync(
  join(rawDir, `${runName}-summary.json`),
  JSON.stringify(
    {
      runName,
      durationSeconds,
      containers,
      postgres: {
        walLsnOffsetBytes: walLsn,
        logsTotalSize: logsSize,
        rollupTotalSize: rollupSize,
        indexSize: indexSize,
        bufferHits: buffers,
      },
    },
    null,
    2,
  ),
);

console.log(`resources: ${csvPath}`);
console.log(`summary: ${join(rawDir, `${runName}-summary.json`)}`);
