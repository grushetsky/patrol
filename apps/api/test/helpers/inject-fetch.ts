import type { FastifyInstance } from "fastify";

/**
 * Adapts fastify's injector to the global fetch signature so the generated
 * openapi-fetch client can be exercised in tests without a listener.
 * openapi-fetch hands its custom fetch a Request object; the origin is
 * thrown away and only the path is injected.
 */
export function fetchThroughInject(app: FastifyInstance): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request =
      input instanceof Request
        ? input
        : new Request(new URL(String(input), "http://patrol.test"), init);

    const url = new URL(request.url);
    const payload =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.text();

    const response = await app.inject({
      method: request.method,
      url: url.pathname + url.search,
      headers: Object.fromEntries(new Headers(request.headers).entries()),
      payload,
    });

    return new Response(response.body, {
      status: response.statusCode,
      headers: new Headers(
        Object.entries(response.headers)
          .filter(([, value]) => value !== undefined)
          .map(([name, value]) => [name, String(value)]),
      ),
    });
  };
}
