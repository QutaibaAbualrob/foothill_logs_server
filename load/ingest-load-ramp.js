import http from "k6/http";
import { check } from "k6";
import { Trend, Rate } from "k6/metrics";

// Ramp scenarios: stress (15k -> 22.5k), spike (7.5k -> 30k -> 7.5k), and
// breakpoint (15k -> 45k), driven by environment variables so one file serves
// all three shapes. Reuses the same payload shape and backdating rules as
// ingest-load.js so results stay comparable across scenarios.
//
//   LOGS_PER_SECOND_START / LOGS_PER_SECOND_END / LOGS_PER_SECOND_STEPS
//   e.g. stress:    15000 22500 4   (constant-size steps)
//        spike:     7500 30000 2 then a down-ramp is appended automatically
//        breakpoint: 15000 45000 6

const startRate = Number(__ENV.LOGS_PER_SECOND_START ?? 15000);
const endRate = Number(__ENV.LOGS_PER_SECOND_END ?? 22500);
const steps = Number(__ENV.LOGS_PER_SECOND_STEPS ?? 4);
const batchSize = Number(__ENV.BATCH_SIZE ?? 50);
const duration = __ENV.DURATION ?? "120s";
const backdateFraction = Number(__ENV.BACKDATE_FRACTION ?? 0.1);

const stepSize = (endRate - startRate) / steps;
const up = Array.from({ length: steps }, (_, index) => ({
  duration: `${Math.round(Number.parseInt(duration, 10) / (steps * 2))}s`,
  target: Math.round(startRate + stepSize * (index + 1)),
}));
const down = Array.from({ length: steps }, (_, index) => ({
  duration: `${Math.round(Number.parseInt(duration, 10) / (steps * 2))}s`,
  target: Math.round(endRate - stepSize * (index + 1)),
}));
const stages = [...up, ...down];
// For a plain stress ramp (no spike), the down-ramp still returns to the
// start rate; a pure ramp is expressible with endRate == startRate steps=1.

const aggregateLatency = new Trend("aggregate_latency", true);
const ingestErrors = new Rate("ingest_errors");

export const options = {
  scenarios: {
    ingest: {
      executor: "ramping-arrival-rate",
      startRate: Math.ceil(startRate / batchSize),
      timeUnit: "1s",
      preAllocatedVUs: 50,
      maxVUs: 600,
      stages,
      exec: "ingest",
    },
    aggregate: {
      executor: "constant-arrival-rate",
      rate: 1,
      timeUnit: "1s",
      duration,
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

const baseUrl = __ENV.BASE_URL ?? "http://api:8080";
const services = ["checkout", "auth", "catalog", "payments", "billing"];
const levels = ["debug", "info", "warn", "error"];
const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

function frac(seed) {
  const value = Math.sin(seed) * 10000;
  return value - Math.floor(value);
}

export function ingest() {
  const now = Date.now();
  const iteration = __ITER;
  const logs = Array.from({ length: batchSize }, (_, index) => {
    const seed = iteration * 7919 + __VU * 104729 + index * 31;
    const backdated = frac(seed) < backdateFraction;
    const timestamp = backdated
      ? new Date(now - frac(seed + 7) * sevenDaysMs).toISOString()
      : new Date(now - (index % 1000)).toISOString();
    return {
      timestamp,
      level: levels[(index + __VU) % levels.length],
      service: services[(index + __VU) % services.length],
      message: `load event ${iteration}-${index}`,
      attributes: {
        trace_id: `${__VU}-${iteration}-${index}`,
        region: "eu-west",
        retry: index % 3,
        latency_ms: (index * 13) % 500,
      },
    };
  });
  if (iteration % 50 === 0 && logs.length > 0) {
    logs[logs.length - 1] = { ...logs[logs.length - 1], level: "fatal" };
  }
  const response = http.post(`${baseUrl}/logs`, JSON.stringify({ logs }), {
    headers: { "Content-Type": "application/json" },
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
