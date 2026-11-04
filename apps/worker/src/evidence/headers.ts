const FORBIDDEN_HEADERS: Record<string, true> = {
  "set-cookie": true,
  cookie: true,
  authorization: true,
};

/** Response headers without visitor credentials. */
export function sanitiseHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !FORBIDDEN_HEADERS[name.toLowerCase()]),
  );
}
