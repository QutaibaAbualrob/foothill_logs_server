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
