import { createServer, type Server } from "node:http";

export interface WorkerOptions {
  port?: number;
  host?: string;
}

/** The worker's health surface, used by Compose and the load balancer. */
export function createWorker(options: WorkerOptions = {}): Server {
  const port = options.port ?? Number(process.env.WORKER_PORT ?? 3001);
  const host = options.host ?? "0.0.0.0";

  return createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "not_found", message: "No such route." }));
  }).listen(port, host);
}
