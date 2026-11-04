import createClient from "openapi-fetch";
import type { paths } from "../generated/openapi";

/**
 * The typed client generated from the TypeSpec-emitted OpenAPI 3.1 document.
 * `openapi-typescript` emits only types; `openapi-fetch` supplies the runtime.
 * The deployment mounts the API under `/api`, so the browser base is relative.
 */
export const api = createClient<paths>({ baseUrl: "/api" });
