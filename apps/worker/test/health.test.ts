import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createWorker } from "../src/server.js";

const servers: ReturnType<typeof createWorker>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

describe("worker health", () => {
  it("answers health on its own port", async () => {
    const server = createWorker({ port: 0, host: "127.0.0.1" });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("answers an unknown route with a not-found body", async () => {
    const server = createWorker({ port: 0, host: "127.0.0.1" });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/nope`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  });
});
