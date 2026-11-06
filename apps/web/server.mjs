// Production Node adapter for the TanStack Start build (docs/adr/0027).
//
// `vite build` emits a WinterCG-style server entry — `dist/server/server.js`
// exports `{ fetch(request) }` — and static client assets under
// `dist/client/`. Nothing in that output listens on a socket, so the
// container needs this small `node:http` front end: it serves the hashed
// client assets straight from disk and hands every other request to the
// app's fetch entry. The ALB (compose: the published port) fronts this
// listener for everything that is not /api.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import entry from "./dist/server/server.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const clientDir = resolve(here, "dist/client");
const port = Number(process.env.PORT ?? 3000);

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/** Serves a file from `dist/client` when the path names one; the hashed
 * assets are immutable, everything else revalidates. */
async function tryServeStatic(pathname, res) {
  if (extname(pathname) === "") return false;
  const filePath = normalize(join(clientDir, decodeURIComponent(pathname)));
  if (filePath !== clientDir && !filePath.startsWith(clientDir + "/")) return false;
  let body;
  try {
    body = await readFile(filePath);
  } catch {
    return false; // not a file the build emitted — the app answers instead
  }
  const type = extname(filePath);
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[type] ?? "application/octet-stream",
    "cache-control": type === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
  });
  res.end(body);
  return true;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url ?? "/",
      `${req.headers["x-forwarded-proto"] ?? "http"}://${req.headers.host ?? `127.0.0.1:${port}`}`,
    );
    if (await tryServeStatic(url.pathname, res)) return;

    const method = req.method ?? "GET";
    const request = new Request(url, {
      method,
      headers: req.headers,
      body: method === "GET" || method === "HEAD" ? undefined : await readBody(req),
    });
    const response = await entry.fetch(request);
    const headers = [];
    response.headers.forEach((value, key) => {
      if (key !== "set-cookie") headers.push([key, value]);
    });
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      headers.push(["set-cookie", cookie]);
    }
    res.writeHead(response.status, headers);
    if (response.body == null || method === "HEAD") {
      res.end();
      return;
    }
    Readable.fromWeb(response.body).pipe(res);
  } catch (error) {
    console.error("web adapter request failed", error);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("internal error");
  }
});

server.listen(port, () => {
  console.log(`patrol web listening on ${port}, assets from ${clientDir}`);
});
