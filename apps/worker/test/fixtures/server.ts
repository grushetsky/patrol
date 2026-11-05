import { createServer, type Server } from "node:http";

/**
 * The fixture pages the capture tests drive a real Chromium at (seam 1):
 * a normal page, a two-hop redirect chain, a dead page, a challenge page,
 * an objection page, a 451 that names no one, an over-ceiling DOM, an
 * over-cap tall page, a page wider than the viewport, and a hanging route
 * for the timeout. The server records the paths it actually served, so a
 * test can prove a blocked resource never reached the wire.
 */

/** The smallest valid PNG: a 1x1 transparent pixel. */
const PIXEL_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000105ab5e30760000000049454e44ae426082",
  "hex",
);

const NORMAL_PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Fixture Work — Watch Online</title>
<meta name="description" content="A fixture page for capture tests.">
<meta property="og:title" content="Fixture Work">
<script type="application/ld+json">{"@type":"VideoObject","name":"Fixture Work"}</script>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<h1>Fixture Work</h1>
<p>A deterministic fixture body.</p>
<iframe src="/embed" width="640" height="360"></iframe>
<iframe src="/ad-frame" width="300" height="250" title="advertisement"></iframe>
<video src="/media/fixture.mp4" controls></video>
<img src="/poster.png" alt="poster">
<a href="/download/fixture.mkv">Download</a>
<a href="magnet:?xt=urn:btih:fixture0000000000000000000000&dn=fixture">Magnet</a>
</body>
</html>`;

const CHALLENGE_PAGE = `<!doctype html>
<html><head><title>Please complete the CAPTCHA to continue</title></head>
<body><h1>Verify you are human</h1></body></html>`;

const OBJECTION_PAGE = `<!doctype html>
<html><head><title>Unavailable for legal reasons</title></head>
<body><p>This page has been taken down following a cease and desist notice naming Patrol.</p></body></html>`;

/** A 451 that names no one: legally walled, but not an objection to Patrol. */
const BARE_451_PAGE = `<!doctype html>
<html><head><title>Unavailable for legal reasons</title></head>
<body><p>This page is not available in your region.</p></body></html>`;

/** A page whose rendered DOM exceeds the 10 MB ceiling. */
function oversizedDomPage(): string {
  const filler = "<div>" + "x".repeat(1024) + "</div>";
  // 11 * 1024 filler divs ≈ 11.3 MB of HTML.
  const parts: string[] = [
    "<!doctype html><html><head><title>Oversized</title></head><body>",
  ];
  for (let i = 0; i < 11 * 1024; i += 1) {
    parts.push(filler);
  }
  parts.push("</body></html>");
  return parts.join("");
}

/** A page taller than the 16 000-pixel screenshot cap. */
const TALL_PAGE = `<!doctype html>
<html><head><title>Tall Fixture</title></head>
<body><div style="height: 20000px; background: #dddddd;">tall</div></body></html>`;

/** A page wider than the test viewport (800 px) — the screenshot spans it. */
const WIDE_PAGE = `<!doctype html>
<html><head><title>Wide Fixture</title></head>
<body style="margin: 0;"><div style="width: 1600px; height: 100px; background: #eeeeee;">wide</div></body></html>`;

export interface FixtureServer {
  url: string;
  port: number;
  /** The paths the server actually served, in order. */
  served: string[];
  close(): Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const served: string[] = [];
  const server: Server = createServer((request, response) => {
    const path = request.url ?? "/";
    served.push(path);
    // A pinned Date keeps the response headers byte-deterministic across
    // captures, so the dedup test measures the page, not the clock.
    response.setHeader("Date", "Fri, 01 May 2026 10:00:00 GMT");
    switch (true) {
      case path === "/normal":
        // The credential-bearing headers the sanitizer must strip (seam 8).
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Set-Cookie", "fixture_sid=secret; Path=/");
        response.setHeader("Authorization", "Bearer fixture-secret");
        response.setHeader("X-Fixture", "normal");
        response.end(NORMAL_PAGE);
        return;
      case path === "/style.css":
        response.setHeader("Content-Type", "text/css");
        response.end("body { color: #111; }");
        return;
      case path === "/poster.png":
        response.setHeader("Content-Type", "image/png");
        response.end(PIXEL_PNG);
        return;
      case path === "/embed":
        response.setHeader("Content-Type", "text/html");
        response.end("<!doctype html><html><body>embed</body></html>");
        return;
      case path === "/ad-frame":
        // A generic (non-player) iframe: an advertising frame the page
        // carries besides its player, which the sidecar must not read as
        // a player source.
        response.setHeader("Content-Type", "text/html");
        response.end("<!doctype html><html><body>ad</body></html>");
        return;
      case path === "/hop1":
        response.statusCode = 302;
        response.setHeader("Location", "/hop2");
        response.end();
        return;
      case path === "/hop2":
        response.statusCode = 302;
        response.setHeader("Location", "/normal");
        response.end();
        return;
      case path === "/gone":
        response.statusCode = 404;
        response.setHeader("Content-Type", "text/html");
        response.end("<!doctype html><html><body>gone</body></html>");
        return;
      case path === "/challenge":
        response.setHeader("Content-Type", "text/html");
        response.end(CHALLENGE_PAGE);
        return;
      case path === "/objection":
        response.statusCode = 451;
        response.setHeader("Content-Type", "text/html");
        response.end(OBJECTION_PAGE);
        return;
      case path === "/objection-unnamed":
        response.statusCode = 451;
        response.setHeader("Content-Type", "text/html");
        response.end(BARE_451_PAGE);
        return;
      case path === "/huge":
        response.setHeader("Content-Type", "text/html");
        response.end(oversizedDomPage());
        return;
      case path === "/tall":
        response.setHeader("Content-Type", "text/html");
        response.end(TALL_PAGE);
        return;
      case path === "/wide":
        response.setHeader("Content-Type", "text/html");
        response.end(WIDE_PAGE);
        return;
      case path === "/hang":
        // Never answer: the navigation budget is what breaks this.
        return;
      default:
        response.statusCode = 404;
        response.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture server has no port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    served,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}
