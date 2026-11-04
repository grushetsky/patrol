import createClient from "openapi-fetch";
import type { paths } from "../generated/openapi";

const BASE_URL = import.meta.env.SSR
  ? (process.env.API_URL ?? "http://localhost:3000/api")
  : "/api";

/** The typed client over the contract's generated `paths`. */
export const api = createClient<paths>({ baseUrl: BASE_URL });
