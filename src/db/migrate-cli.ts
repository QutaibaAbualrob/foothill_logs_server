import { loadConfig } from "../config.js";
import { createPools, closePools } from "./pools.js";
import { migrate } from "./migrate.js";

const config = loadConfig();
const pools = createPools(config);
try {
  await migrate(pools.maintenance, config.retentionDays, config.hotAttributeKeys);
  console.log("migrations applied");
} finally {
  await closePools(pools);
}
