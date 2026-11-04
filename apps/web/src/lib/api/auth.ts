import { api } from "./client";

/**
 * The CSRF pair every mutation carries, resolved per the API's pairing
 * rules (plugins/auth.ts):
 *
 * - an anonymous mutation (sign-in, second factor, the enrolment ceremony,
 *   invitation acceptance) pairs the X-Patrol-CSRF header with the
 *   patrol_csrf cookie GET /auth/csrf sets — fetchCsrfToken;
 * - an authenticated mutation pairs the header with the session's own
 *   token, which GET /auth/session returns — fetchSessionCsrfToken.
 *
 * Mixing the two answers 403: while a session cookie rides along, the
 * anonymous pair does not authenticate a mutation.
 */

export async function fetchCsrfToken(): Promise<string> {
  const { data, response } = await api.GET("/auth/csrf");
  if (!response.ok || !data) {
    throw new Error("failed to obtain a CSRF token");
  }
  return data.csrfToken;
}

/** The session's own CSRF token; null when no session cookie is valid. */
export async function fetchSessionCsrfToken(): Promise<string | null> {
  const { data, response } = await api.GET("/auth/session");
  if (!response.ok || !data) {
    return null;
  }
  return data.csrfToken;
}

/** The header object an authenticated mutation carries. */
export function sessionCsrfHeader(token: string): {
  "X-Patrol-CSRF": string;
} {
  return { "X-Patrol-CSRF": token };
}
