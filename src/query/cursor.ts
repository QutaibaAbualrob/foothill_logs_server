import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "../errors.js";
import type { CursorKey, QueryFilters } from "./types.js";

interface CursorPayload {
  readonly v: 1;
  readonly t: string;
  readonly i: string;
  readonly f: string;
}

const DATABASE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export class CursorCodec {
  public constructor(private readonly secret: string) {}

  public encode(key: CursorKey, filterHash: string): string {
    const payload: CursorPayload = { v: 1, t: key.timestamp, i: key.id, f: filterHash };
    const json = JSON.stringify(payload);
    const body = Buffer.from(json).toString("base64url");
    return `${body}.${this.signature(body)}`;
  }

  public decode(value: string, expectedFilterHash: string): CursorKey {
    const parts = value.split(".");
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
      throw new HttpError(400, "invalid cursor");
    }
    const expectedSignature = this.signature(parts[0]);
    const actual = Buffer.from(parts[1]);
    const expected = Buffer.from(expectedSignature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new HttpError(400, "invalid cursor signature");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    } catch {
      throw new HttpError(400, "malformed cursor");
    }
    if (!isPayload(payload)) throw new HttpError(400, "malformed cursor");
    if (payload.f !== expectedFilterHash) {
      throw new HttpError(400, "cursor does not match the active filters");
    }
    return { timestamp: payload.t, id: payload.i };
  }

  private signature(body: string): string {
    return createHmac("sha256", this.secret).update(body).digest("base64url").slice(0, 22);
  }
}

export function filterHash(filters: QueryFilters): string {
  const canonical = JSON.stringify({
    service: filters.service ?? null,
    level: filters.level ?? null,
    since: filters.since ?? null,
    until: filters.until ?? null,
    q: filters.q ?? null,
    attributes: Object.entries(filters.attributes).sort(([left], [right]) => left.localeCompare(right)),
  });
  return createHash("sha256").update(canonical).digest("base64url").slice(0, 22);
}

function isPayload(value: unknown): value is CursorPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<CursorPayload>;
  return (
    candidate.v === 1 &&
    typeof candidate.t === "string" &&
    DATABASE_TIMESTAMP.test(candidate.t) &&
    Number.isFinite(Date.parse(candidate.t)) &&
    typeof candidate.i === "string" &&
    /^[1-9]\d*$/.test(candidate.i) &&
    typeof candidate.f === "string" &&
    /^[A-Za-z0-9_-]{22}$/.test(candidate.f)
  );
}
