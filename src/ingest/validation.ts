import { HttpError } from "../errors.js";
import { LOG_LEVELS, type Attributes, type LogLevel, type NormalizedLog, type RejectedLog } from "../types.js";

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const LEVELS = new Set<string>(LOG_LEVELS);
const MAX_FUTURE_MS = 5 * 60 * 1000;
// Ceilings for the two free-text fields. Mirrored by CHECK constraints in
// migration 003; these are the primary gate because rejecting here reports one
// bad entry in `rejected[]` instead of failing the client's whole batch. JS
// .length counts UTF-16 units and PostgreSQL length() counts characters, so a
// non-BMP character counts 2 here and 1 there -- these limits are therefore
// never looser than the constraints backing them.
const MAX_SERVICE_LENGTH = 255;
const MAX_MESSAGE_LENGTH = 65_536;

export interface ValidationResult {
  readonly logs: NormalizedLog[];
  readonly rejected: RejectedLog[];
  readonly estimatedBytes: number;
}

/**
 * @param maxAgeMs How far back a timestamp may be before it is rejected. Defaults
 * to no floor, which is the historical behaviour; the service passes its
 * retention window, because a log older than that would be deleted by the next
 * retention pass anyway and silently accepting it is a lie to the client.
 */
export function validateIngestBody(
  body: unknown,
  nowMs = Date.now(),
  maxAgeMs = Number.POSITIVE_INFINITY,
): ValidationResult {
  if (!isRecord(body) || !Array.isArray(body.logs)) {
    throw new HttpError(400, "request body must be an object containing a logs array");
  }

  const logs: NormalizedLog[] = [];
  const rejected: RejectedLog[] = [];
  let estimatedBytes = 0;

  for (let index = 0; index < body.logs.length; index += 1) {
    const value = body.logs[index];
    const result = validateEntry(value, nowMs, maxAgeMs);
    if (typeof result === "string") {
      rejected.push({ index, reason: result });
    } else {
      logs.push(result);
      estimatedBytes += result.estimatedBytes;
    }
  }

  return { logs, rejected, estimatedBytes };
}

function validateEntry(value: unknown, nowMs: number, maxAgeMs: number): NormalizedLog | string {
  if (!isRecord(value)) return "log entry must be an object";

  if (typeof value.timestamp !== "string" || !ISO_TIMESTAMP.test(value.timestamp)) {
    return "timestamp must be a valid ISO 8601 value with an explicit timezone";
  }
  const timestampMs = Date.parse(value.timestamp);
  if (!Number.isFinite(timestampMs)) return "timestamp must be a valid ISO 8601 timestamp";
  if (timestampMs > nowMs + MAX_FUTURE_MS) {
    return "timestamp must not be more than five minutes in the future";
  }
  // Without a floor a backdated entry lands in the DEFAULT partition, which
  // dropExpiredPartitions never drops -- it matches only logs_YYYY_MM -- so it
  // is reclaimed by the slow batched DELETE rather than an instant DROP.
  if (timestampMs < nowMs - maxAgeMs) {
    return "timestamp is older than the retention window";
  }
  if (typeof value.level !== "string" || !LEVELS.has(value.level)) {
    return `invalid level: '${String(value.level)}'`;
  }
  if (typeof value.service !== "string" || value.service.length === 0) {
    return "service must be a non-empty string";
  }
  if (value.service.length > MAX_SERVICE_LENGTH) {
    return `service must be at most ${String(MAX_SERVICE_LENGTH)} characters`;
  }
  if (value.service.includes("\u0000")) return "service contains an unsupported null character";
  if (typeof value.message !== "string" || value.message.length === 0) {
    return "message must be a non-empty string";
  }
  if (value.message.length > MAX_MESSAGE_LENGTH) {
    return `message must be at most ${String(MAX_MESSAGE_LENGTH)} characters`;
  }
  if (value.message.includes("\u0000")) return "message contains an unsupported null character";

  const attributeResult = validateAttributes(value.attributes);
  if (typeof attributeResult === "string") return attributeResult;
  const attributesJson = JSON.stringify(attributeResult);
  const estimatedBytes =
    Buffer.byteLength(value.timestamp) +
    Buffer.byteLength(value.level) +
    Buffer.byteLength(value.service) +
    Buffer.byteLength(value.message) +
    Buffer.byteLength(attributesJson) +
    32;

  return {
    timestamp: value.timestamp,
    level: value.level as LogLevel,
    service: value.service,
    message: value.message,
    attributes: attributeResult,
    attributesJson,
    estimatedBytes,
  };
}

function validateAttributes(value: unknown): Attributes | string {
  if (value === undefined) return {};
  if (!isRecord(value)) return "attributes must be a flat object";
  const attributes: Attributes = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.includes("\u0000")) return "attribute keys cannot contain a null character";
    if (typeof item === "string") {
      if (item.includes("\u0000")) return `attribute '${key}' contains an unsupported null character`;
      attributes[key] = item;
      continue;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return `attribute '${key}' must be a finite number`;
      attributes[key] = item;
      continue;
    }
    if (typeof item === "boolean") {
      attributes[key] = item;
      continue;
    }
    return `attribute '${key}' must be a string, number, or boolean`;
  }
  return attributes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
