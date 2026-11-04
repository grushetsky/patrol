import { createWorker } from "./server.js";

const server = createWorker();
console.log(`Patrol worker listening on ${JSON.stringify(server.address())}`);

const shutdown = (signal: string) => {
  console.log(`Worker shutting down on ${signal}.`);
  server.close(() => process.exit(0));
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
