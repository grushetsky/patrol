import type { Contract } from "./contract.js";
import { ValidationError } from "./errors.js";
import type { FastifyRequest } from "fastify";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export interface Page {
  page: number;
  pageSize: number;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function validateBody(
  contract: Contract,
  request: FastifyRequest,
  name: string,
): Record<string, unknown> {
  const result = contract.validate(name, request.body);
  if (!result.valid) {
    throw new ValidationError(result.issues);
  }
  return request.body as Record<string, unknown>;
}

export function validatedBody<T>(
  contract: Contract,
  request: FastifyRequest,
  name: string,
): T {
  return validateBody(contract, request, name) as unknown as T;
}

export function queryPage(request: FastifyRequest): Page {
  const query = request.query as { page?: string; pageSize?: string };
  return {
    page: Math.max(1, Number(query.page ?? 1)),
    pageSize: Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Number(query.pageSize ?? DEFAULT_PAGE_SIZE)),
    ),
  };
}

export function pageOf<T>(items: T[], page: Page): PageResult<T> {
  const start = (page.page - 1) * page.pageSize;
  return {
    items: items.slice(start, start + page.pageSize),
    total: items.length,
    page: page.page,
    pageSize: page.pageSize,
  };
}

export function paginate<T, R = T>(
  request: FastifyRequest,
  items: T[],
  map?: (item: T) => R,
): PageResult<R> {
  return pageOf(items.map((item) => (map ? map(item) : (item as unknown as R))), queryPage(request));
}
