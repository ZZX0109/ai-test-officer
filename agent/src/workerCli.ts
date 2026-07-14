import { startRunWorker } from "./runOrchestrator.js";

if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
  throw new Error("DATABASE_URL and REDIS_URL are required for the production worker");
}
await startRunWorker();
console.log("AI Test Officer execution worker is ready");
