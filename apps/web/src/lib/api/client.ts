import createClient from "openapi-fetch";
import type { paths } from "./schema";

/**
 * The typed client generated from the contract's OpenAPI 3.1 document.
 * `openapi-typescript` emits only types; `openapi-fetch` supplies the runtime.
 * Server rendering calls the API through its internal URL, while the browser
 * goes through the same-origin `/api` the proxy (dev) or the ALB (deploy)
 * routes for it.
 */
const baseUrl =
  typeof document === "undefined"
    ? (process.env.PATROL_API_INTERNAL_URL ?? "http://127.0.0.1:8080/api")
    : "/api";

export const api = createClient<paths>({ baseUrl });

/**
 * A failed API call: carries the HTTP status and the ErrorBody's stable
 * `code` so the UI can branch on it; `message` is display text.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}
