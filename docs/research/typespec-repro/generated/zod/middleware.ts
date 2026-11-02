import { z } from "zod";
import {
	CaseStatusSchema,
	CreateNoticeRequestSchema,
} from "./schemas.js";

export interface OperationSchemas {
	readonly operationId: string;
	readonly method: string;
	readonly path: string;
	readonly pattern: RegExp;
	readonly pathParameterNames: readonly string[];
	readonly body?: z.ZodTypeAny;
	readonly parameters: {
		readonly path?: z.ZodTypeAny;
		readonly query?: z.ZodTypeAny;
		readonly header?: z.ZodTypeAny;
		readonly cookie?: z.ZodTypeAny;
	};
}

export const operations: readonly OperationSchemas[] = [
	{
		operationId: "Violations_list",
		method: "GET",
		path: "/violations",
		pattern: /^.*\/violations\/?$/,
		pathParameterNames: [],
		parameters: { query: z.object({ page: z.number(), pageSize: z.number(), status: CaseStatusSchema.optional() }) },
	},
	{
		operationId: "Violations_read",
		method: "GET",
		path: "/violations/{id}",
		pattern: /^.*\/violations\/([^/]+)\/?$/,
		pathParameterNames: ["id"],
		parameters: { path: z.object({ id: z.string().uuid() }) },
	},
	{
		operationId: "Violations_createNotice",
		method: "POST",
		path: "/violations/{id}/notices",
		pattern: /^.*\/violations\/([^/]+)\/notices\/?$/,
		pathParameterNames: ["id"],
		body: CreateNoticeRequestSchema,
		parameters: { path: z.object({ id: z.string().uuid() }) },
	},
];

export interface RequestContext {
	url: string;
	init: RequestInit;
}

export interface ValidationMiddleware {
	pre(context: RequestContext): Promise<void>;
}

export interface ValidationMiddlewareOptions {
	validate?: boolean;
}

export class RequestValidationError extends Error {
	override readonly name = "RequestValidationError";
	readonly issues: z.ZodIssue[];

	constructor(
		readonly operationId: string,
		readonly method: string,
		readonly url: string,
		readonly error: z.ZodError,
	) {
		super(
			`${method} ${url} (${operationId}) request body failed validation: ${error.issues
				.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
				.join("; ")}`,
		);
		this.issues = error.issues;
	}
}

// A route pattern tolerates a base path, so a short route matches a longer
// request path too: /items matches /orders/order-1/items. Matching walks the
// most specific route first, where a literal segment beats a parameter segment
// and a longer path beats a shorter one.
const routes: readonly OperationSchemas[] = [...operations].sort(
	(left, right) => compareSpecificity(left.path, right.path),
);

function pathSegments(path: string): string[] {
	return path.split("/").filter((segment) => segment !== "");
}

function literalSegmentCount(segments: readonly string[]): number {
	return segments.filter((segment) => !segment.includes("{")).length;
}

function compareSpecificity(left: string, right: string): number {
	const leftSegments = pathSegments(left);
	const rightSegments = pathSegments(right);

	return (
		literalSegmentCount(rightSegments) - literalSegmentCount(leftSegments) ||
		rightSegments.length - leftSegments.length
	);
}

export function findOperation(
	method: string,
	url: string,
): OperationSchemas | undefined {
	const wanted = method.toUpperCase();
	const pathname = pathnameOf(url);

	return routes.find(
		(operation) =>
			operation.method === wanted && operation.pattern.test(pathname),
	);
}

export function createValidationMiddleware(
	options: ValidationMiddlewareOptions = {},
): ValidationMiddleware {
	const validate = options.validate ?? true;

	return {
		async pre(context: RequestContext): Promise<void> {
			if (!validate) {
				return;
			}

			const method = (context.init.method ?? "GET").toUpperCase();
			const operation = findOperation(method, context.url);
			if (!operation?.body) {
				return;
			}

			const body = context.init.body;
			if (typeof body !== "string") {
				return;
			}

			const contentType = headerValue(context.init, "content-type");
			if (contentType && !contentType.includes("json")) {
				return;
			}

			const result = operation.body.safeParse(parseJson(body));
			if (result.success) {
				return;
			}

			throw new RequestValidationError(
				operation.operationId,
				method,
				context.url,
				result.error,
			);
		},
	};
}

export const validationMiddleware: ValidationMiddleware =
	createValidationMiddleware();

function pathnameOf(url: string): string {
	const withoutQuery = url.split("#")[0].split("?")[0];
	const scheme = withoutQuery.indexOf("://");
	if (scheme === -1) {
		return withoutQuery;
	}

	const authority = withoutQuery.slice(scheme + 3);
	const separator = authority.indexOf("/");
	return separator === -1 ? "/" : authority.slice(separator);
}

function headerValue(init: RequestInit, name: string): string | undefined {
	const headers = init.headers;
	if (!headers) {
		return undefined;
	}
	if (headers instanceof Headers) {
		return headers.get(name) ?? undefined;
	}
	if (Array.isArray(headers)) {
		return headers.find(([key]) => key.toLowerCase() === name)?.[1];
	}

	const key = Object.keys(headers).find((header) => header.toLowerCase() === name);
	return key === undefined ? undefined : headers[key];
}

// A body that is not JSON is handed to zod as-is, so it is reported as a
// validation failure instead of a parse error thrown from the middleware.
function parseJson(body: string): unknown {
	try {
		return JSON.parse(body);
	} catch {
		return body;
	}
}
