import createClient from "openapi-fetch";
import type { paths } from "../../generated/openapi";

/**
 * Typed client generated from the TypeSpec-emitted OpenAPI 3.1 document.
 * `openapi-typescript` emits only types; `openapi-fetch` supplies the runtime.
 */
export const api = createClient<paths>({ baseUrl: "/api" });
