import { Pool } from "pg";
import type { AppConfig } from "../config.js";

export interface DatabasePools {
  readonly write: Pool;
  readonly query: Pool;
  readonly maintenance: Pool;
}

function makePool(
  config: AppConfig,
  max: number,
  applicationName: string,
  statementTimeoutMs: number,
): Pool {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max,
    connectionTimeoutMillis: config.databaseConnectTimeoutMs,
    idleTimeoutMillis: 30_000,
    statement_timeout: statementTimeoutMs,
    application_name: applicationName,
    allowExitOnIdle: false,
  });
  pool.on("error", (error) => {
    console.error(JSON.stringify({ event: "postgres_pool_error", pool: applicationName, message: error.message }));
  });
  return pool;
}

export function createPools(config: AppConfig): DatabasePools {
  return {
    write: makePool(config, config.writePoolSize, "optimized-logger/write", 30_000),
    query: makePool(
      config,
      config.queryPoolSize,
      "optimized-logger/query",
      config.queryStatementTimeoutMs,
    ),
    maintenance: makePool(config, 1, "optimized-logger/maintenance", 30_000),
  };
}

export async function probeDatabase(pool: Pick<Pool, "query">): Promise<void> {
  await pool.query("SELECT 1");
}

export async function closePools(pools: DatabasePools): Promise<void> {
  await Promise.allSettled([pools.write.end(), pools.query.end(), pools.maintenance.end()]);
}

export function isPoolTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.includes("timeout exceeded");
}

// PostgreSQL error codes that mean "the server cannot serve this right now",
// as distinct from "this request was wrong". These map to 503, never 500 or
// 400: the client did nothing wrong and the request is worth retrying.
const UNAVAILABLE_SQL_STATES = new Set([
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now — server is starting up
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "53300", // too_many_connections
  "53200", // out_of_memory
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available
]);

const UNAVAILABLE_SYSTEM_ERRORS = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  // Name resolution failures. The database host is a name, not an address, so
  // every way that name can fail to resolve is the database being unreachable
  // — never a bad request, and never an internal defect.
  //
  // All of these must be listed, because which one arrives depends on the
  // resolver rather than on the fault. A container runtime whose embedded DNS
  // answers NXDOMAIN for a stopped service surfaces ENOTFOUND, while one that
  // answers SERVFAIL surfaces EAI_AGAIN for the identical outage. Listing only
  // ENOTFOUND mapped that second case to 500 instead of 503 + Retry-After, and
  // also stopped withDatabaseRetry from retrying a resolver blip at startup.
  "ENOTFOUND", // EAI_NONAME — no such host
  "EAI_AGAIN", // temporary resolver failure, e.g. SERVFAIL
  "EAI_NONAME",
  "EAI_NODATA",
  "EAI_FAIL",
]);

/**
 * True when a failure is the database being unreachable, shutting down, or
 * refusing new work — the cases that must surface as 503 + Retry-After.
 *
 * node-postgres reports a lost connection as a plain Error with no SQLSTATE
 * ("Connection terminated unexpectedly"), so message matching is unavoidable
 * for that family; everything else is matched on a code.
 */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    if (UNAVAILABLE_SQL_STATES.has(code) || UNAVAILABLE_SYSTEM_ERRORS.has(code)) return true;
  }
  const message = error.message;
  return (
    isPoolTimeout(error) ||
    message.includes("Connection terminated") ||
    message.includes("Client has encountered a connection error") ||
    message.includes("terminating connection") ||
    message.includes("server closed the connection") ||
    message.includes("Cannot use a pool after calling end")
  );
}

/**
 * Runs the startup work that needs the database, retrying with bounded
 * exponential backoff. Without this the top-level await in index.ts rejects the
 * moment PostgreSQL is briefly unavailable, the process exits, and the restart
 * policy turns a transient outage into a crash loop that cannot recover until
 * the database happens to be up at the instant a restart lands.
 */
export async function withDatabaseRetry<T>(
  operation: () => Promise<T>,
  options: { readonly attempts: number; readonly baseDelayMs: number; readonly label: string },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isDatabaseUnavailable(error) || attempt === options.attempts) throw error;
      const delay = Math.min(options.baseDelayMs * 2 ** (attempt - 1), 5_000);
      console.warn(
        JSON.stringify({
          event: "startup_retry",
          step: options.label,
          attempt,
          of: options.attempts,
          delayMs: delay,
          message: error instanceof Error ? error.message : "unknown error",
        }),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
