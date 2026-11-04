import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightCapture } from "../src/evidence/browser.js";

const candidatePaths = [
  process.env.PATROL_CHROMIUM_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
].filter((value): value is string => Boolean(value));
const executablePath = candidatePaths.find((path) => existsSync(path));
const suite = executablePath ? describe : describe.skip;

let server: Server;
let baseUrl: string;
const capture = executablePath
  ? new PlaywrightCapture(executablePath)
  : null;

beforeAll(async () => {
  if (!executablePath) {
    return;
  }
  server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/captured" });
      response.end();
      return;
    }
    if (request.url === "/dead") {
      response.writeHead(404, { "content-type": "text/html" });
      response.end("<html><body>Not found</body></html>");
      return;
    }
    if (request.url === "/tall") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        '<html><head><title>Tall</title></head><body><div style="height:17000px">Tall page</div></body></html>',
      );
      return;
    }
    if (request.url === "/blocked") {
      response.writeHead(403, { "content-type": "text/html" });
      response.end("<html><body>Forbidden</body></html>");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html><head><title>Fixture film</title>
      <meta property="og:title" content="Fixture film"></head>
      <body><h1>Fixture film</h1>
      <script type="application/ld+json">{"@type":"VideoObject","name":"Fixture"}</script>
      <a href="magnet:?xt=urn:btih:abc">Download</a>
      </body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await capture!.start();
}, 120_000);

afterAll(async () => {
  await capture?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

suite("Playwright capture fixtures", () => {

  it("captures a rendered page with its artifacts", async () => {
    const result = await capture!.capture(`${baseUrl}/captured`, "detection");

    expect(result.outcome).toBe("captured");
    expect(result.httpStatus).toBe(200);
    expect(result.finalUrl).toBe(`${baseUrl}/captured`);
    expect(result.host).toBe("127.0.0.1");
    expect(result.redirectChain).toHaveLength(1);
    expect(result.responseBody?.toString("utf8")).toContain("Fixture film");
    expect(result.dom).toContain("Fixture film");
    expect(result.domTruncated).toBe(false);
    expect(result.screenshot?.bytes.subarray(1, 4).toString()).toBe("PNG");
    expect(result.screenshot?.height).toBeLessThanOrEqual(16_000);
    expect(result.thumbnail?.bytes.subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(result.sidecar).toMatchObject({ title: "Fixture film" });
    expect(result.headers?.["set-cookie"]).toBeUndefined();
  }, 60_000);

  it("records a redirect chain and the destination", async () => {
    const result = await capture!.capture(`${baseUrl}/redirect`, "detection");

    expect(result.outcome).toBe("captured");
    expect(result.redirectChain).toHaveLength(2);
    expect(result.redirectChain[0]).toMatchObject({
      statusCode: 302,
      location: "/captured",
    });
    expect(result.finalUrl).toBe(`${baseUrl}/captured`);
  }, 60_000);

  it("caps a tall screenshot and flags the truncation", async () => {
    const result = await capture!.capture(`${baseUrl}/tall`, "detection");

    expect(result.outcome).toBe("captured");
    expect(result.screenshot?.height).toBe(16_000);
    expect(result.screenshot?.truncated).toBe(true);
  }, 60_000);

  it("classifies a 404 as dead and a 403 as blocked", async () => {
    const dead = await capture!.capture(`${baseUrl}/dead`, "detection");
    expect(dead.outcome).toBe("dead");
    expect(dead.httpStatus).toBe(404);

    const blocked = await capture!.capture(`${baseUrl}/blocked`, "detection");
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.httpStatus).toBe(403);
  }, 60_000);
});
