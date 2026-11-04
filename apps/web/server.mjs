import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import entry from "./dist/server/server.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const API_PROXY = process.env.API_PROXY ?? "http://localhost:3000";
const CLIENT_ROOT = fileURLToPath(new URL("./dist/client/", import.meta.url));

const contentTypes = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

async function serveAsset(pathname) {
  if (!pathname.startsWith("/assets/")) {
    return undefined;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const candidate = resolve(CLIENT_ROOT, `.${decoded}`);
  if (!candidate.startsWith(CLIENT_ROOT.endsWith(sep) ? CLIENT_ROOT : `${CLIENT_ROOT}${sep}`)) {
    return undefined;
  }
  try {
    return {
      body: await readFile(candidate),
      type: contentTypes[extname(candidate)] ?? "application/octet-stream",
    };
  } catch {
    return undefined;
  }
}

createServer(async (request, response) => {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );

  const asset = await serveAsset(url.pathname);
  if (asset) {
    response.writeHead(200, { "content-type": asset.type });
    response.end(asset.body);
    return;
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  if (url.pathname.startsWith("/api/")) {
    const target = new URL(`${url.pathname}${url.search}`, API_PROXY);
    const proxyResponse = await fetch(target, {
      method: request.method,
      headers: request.headers,
      body: hasBody ? Readable.toWeb(request) : undefined,
      duplex: hasBody ? "half" : undefined,
    });
    response.writeHead(
      proxyResponse.status,
      Object.fromEntries(proxyResponse.headers.entries()),
    );
    if (proxyResponse.body) {
      Readable.fromWeb(proxyResponse.body).pipe(response);
    } else {
      response.end();
    }
    return;
  }

  const fetchRequest = new Request(url, {
    method: request.method,
    headers: request.headers,
    body: hasBody ? Readable.toWeb(request) : undefined,
    duplex: hasBody ? "half" : undefined,
  });

  try {
    const fetchResponse = await entry.fetch(fetchRequest);
    response.writeHead(
      fetchResponse.status,
      Object.fromEntries(fetchResponse.headers.entries()),
    );
    if (fetchResponse.body) {
      Readable.fromWeb(fetchResponse.body).pipe(response);
    } else {
      response.end();
    }
  } catch (error) {
    console.error(error);
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "application/json" });
    }
    response.end(JSON.stringify({ code: "internal_error", message: "Internal server error." }));
  }
}).listen(PORT, HOST, () => {
  console.log(`Patrol web listening on ${HOST}:${PORT}`);
});
