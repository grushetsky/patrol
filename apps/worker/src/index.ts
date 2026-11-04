import { createWorker } from "./server.js";
import { startJobs, type WorkerJobs } from "./jobs.js";

const server = createWorker();
let jobs: WorkerJobs | undefined;

if (process.env.DATABASE_URL) {
  jobs = await startJobs(process.env.DATABASE_URL);
  console.log("Patrol worker jobs started.");
}

const shutdown = async (signal: string) => {
  console.log(`Worker shutting down on ${signal}.`);
  await jobs?.stop();
  server.close(() => process.exit(0));
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
