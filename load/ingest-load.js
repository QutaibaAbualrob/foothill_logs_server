import http from "k6/http";
import { check } from "k6";
import { Trend, Rate } from "k6/metrics";

const targetLogsPerSecond = Number(__ENV.LOGS_PER_SECOND ?? 15000);
const batchSize = Number(__ENV.BATCH_SIZE ?? 50);
const requestRate = Math.ceil(targetLogsPerSecond / batchSize);
const aggregateLatency = new Trend("aggregate_latency", true);
const ingestErrors = new Rate("ingest_errors");

export const options = {
  scenarios: {
    ingest: {
      executor: "constant-arrival-rate",
      rate: requestRate,
      timeUnit: "1s",
      duration: __ENV.DURATION ?? "60s",
      preAllocatedVUs: 50,
      maxVUs: 300,
      exec: "ingest",
    },
    aggregate: {
      executor: "constant-arrival-rate",
      rate: 1,
      timeUnit: "1s",
      duration: __ENV.DURATION ?? "60s",
      preAllocatedVUs: 2,
      exec: "aggregate",
    },
  },
  thresholds: {
    ingest_errors: ["rate==0"],
    http_req_failed: ["rate==0"],
    aggregate_latency: ["p(95)<1000"],
  },
};

const baseUrl = __ENV.BASE_URL ?? "http://localhost:8080";
const services = ["checkout", "auth", "catalog", "payments"];
const levels = ["debug", "info", "warn", "error"];

export function ingest() {
  const now = Date.now();
  const logs = Array.from({ length: batchSize }, (_, index) => ({
    timestamp: new Date(now - (index % 1000)).toISOString(),
    level: levels[(index + __VU) % levels.length],
    service: services[(index + __VU) % services.length],
    message: `load event ${__ITER}-${index}`,
    attributes: { trace_id: `${__VU}-${__ITER}-${index}`, region: "eu-west", retry: index % 3 },
  }));
  const response = http.post(`${baseUrl}/logs`, JSON.stringify({ logs }), {
    headers: { "Content-Type": "application/json", Authorization: "Bearer ignored" },
  });
  ingestErrors.add(response.status !== 200);
  check(response, { "ingest accepted": (item) => item.status === 200 });
}

export function aggregate() {
  const until = new Date();
  const since = new Date(until.getTime() - 60 * 60 * 1000);
  since.setUTCSeconds(0, 0);
  until.setUTCSeconds(0, 0);
  const response = http.get(
    `${baseUrl}/logs/aggregate?since=${encodeURIComponent(since.toISOString())}&until=${encodeURIComponent(until.toISOString())}&bucket=1m&group_by=service`,
  );
  aggregateLatency.add(response.timings.duration);
  check(response, { "aggregate works": (item) => item.status === 200 });
}
