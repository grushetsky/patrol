import createClient from "openapi-fetch";
import type { paths } from "../generated/openapi";

const BASE_URL = import.meta.env.SSR
  ? (process.env.API_URL ?? "http://localhost:3000/api")
  : "/api";

/** The typed client over the contract's generated `paths`. */
export const api = createClient<paths>({ baseUrl: BASE_URL });

let csrfToken: string | undefined;

/** Fetch the double-submit token and its cookie, then reuse it. */
export async function ensureCsrf(): Promise<string> {
  if (csrfToken) {
    return csrfToken;
  }
  const result = await api.GET("/auth/csrf");
  if (!result.data) {
    throw new ApiError(0, null);
  }
  csrfToken = result.data.csrfToken;
  return csrfToken;
}

export function setCsrf(token: string): void {
  csrfToken = token;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(messageFromBody(body) ?? `API request failed with ${status}`);
    this.name = "ApiError";
  }
}

export function messageFromBody(body: unknown): string | undefined {
  if (
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string"
  ) {
    return body.message;
  }
  return undefined;
}

export function fieldErrorFromBody(body: unknown): string | undefined {
  if (
    typeof body !== "object" ||
    body === null ||
    !("fieldErrors" in body) ||
    !Array.isArray(body.fieldErrors)
  ) {
    return undefined;
  }
  for (const issue of body.fieldErrors) {
    if (
      typeof issue === "object" &&
      issue !== null &&
      "message" in issue &&
      typeof issue.message === "string"
    ) {
      return issue.message;
    }
  }
  return undefined;
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return fieldErrorFromBody(error.body) ?? messageFromBody(error.body) ?? fallback;
  }
  return fallback;
}
