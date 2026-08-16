import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:8080";
const durationSeconds = Number(process.env.DURATION_SECONDS ?? 15);
const concurrency = Number(process.env.CONCURRENCY ?? 64);
const batchSize = Number(process.env.BATCH_SIZE ?? 50);
const resultPath = process.env.RESULT_PATH;
const absoluteResultPath = resultPath === undefined ? undefined : resolve(resultPath);
if (absoluteResultPath !== undefined) {
  mkdirSync(dirname(absoluteResultPath), { recursive: true });
  if (existsSync(absoluteResultPath)) {
    throw new Error(`RESULT_PATH already exists; choose a new path: ${absoluteResultPath}`);
  }
}
const startedAtIso = new Date().toISOString();
const endAt = Date.now() + durationSeconds * 1000;
const ingestLatencies = [];
const aggregateLatencies = [];
let accepted = 0;
let errors = 0;
let sequence = 0;

function body(worker) {
  const request = sequence++;
  const timestamp = new Date().toISOString();
  return JSON.stringify({
    logs: Array.from({ length: batchSize }, (_, index) => ({
      timestamp,
      level: ["debug", "info", "warn", "error"][(worker + index) % 4],
      service: ["checkout", "auth", "catalog", "payments"][(request + index) % 4],
      message: `benchmark event ${request}-${index}`,
      attributes: { trace_id: `bench-${request}-${index}`, region: "eu-west", retry: index % 3 },
    })),
  });
}

async function worker(id) {
  while (Date.now() < endAt) {
    const started = performance.now();
    try {
      const response = await fetch(`${baseUrl}/logs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body(id),
      });
      ingestLatencies.push(performance.now() - started);
      if (response.status !== 200) {
        errors += 1;
        await response.arrayBuffer();
        continue;
      }
      const result = await response.json();
      accepted += result.accepted;
    } catch {
      errors += 1;
    }
  }
}

async function aggregateProbe() {
  while (Date.now() < endAt) {
    const until = new Date();
    until.setUTCSeconds(0, 0);
    const since = new Date(until.getTime() - 60 * 60 * 1000);
    const started = performance.now();
    try {
      const response = await fetch(
        `${baseUrl}/logs/aggregate?since=${encodeURIComponent(since.toISOString())}&until=${encodeURIComponent(until.toISOString())}&bucket=1m&group_by=service`,
      );
      aggregateLatencies.push(performance.now() - started);
      if (!response.ok) errors += 1;
      await response.arrayBuffer();
    } catch {
      errors += 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
}

const startedAt = performance.now();
await Promise.all([
  ...Array.from({ length: concurrency }, (_, index) => worker(index)),
  aggregateProbe(),
]);
const elapsedSeconds = (performance.now() - startedAt) / 1000;
const result = {
  startedAt: startedAtIso,
  endedAt: new Date().toISOString(),
  baseUrl,
  configuredDurationSeconds: durationSeconds,
  concurrency,
  batchSize,
  accepted,
  errors,
  elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
  logsPerSecond: Number((accepted / elapsedSeconds).toFixed(1)),
  ingestionMs: {
    p50: percentile(ingestLatencies, 0.5),
    p95: percentile(ingestLatencies, 0.95),
    p99: percentile(ingestLatencies, 0.99),
  },
  aggregateMs: {
    samples: aggregateLatencies.length,
    p95: percentile(aggregateLatencies, 0.95),
  },
};
const output = `${JSON.stringify(result, null, 2)}\n`;
if (absoluteResultPath !== undefined) {
  writeFileSync(absoluteResultPath, output, { flag: "wx" });
  console.error(`result: ${absoluteResultPath}`);
}
process.stdout.write(output);
if (errors > 0) process.exitCode = 1;
