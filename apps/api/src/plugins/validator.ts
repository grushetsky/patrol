import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
// Named Ajv2020 import and the .default call below are the spellings that
// hold under NodeNext interop for ajv's CommonJS builds: the class is a real
// named export of ajv/dist/2020.js, and ajv-formats attaches its plugin as
// module.exports.default.
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { ValidationError, type FieldError } from "../errors.js";

/**
 * The JSON Schema 2020-12 bundle the contract package emits. It is an
 * extensionless JSON file behind the package's `schemas-bundle` export, so it
 * is resolved through require and read as text rather than imported.
 */
interface SchemaBundle {
  $defs: Record<string, { $id: string } & Record<string, unknown>>;
}

const require = createRequire(import.meta.url);
const bundle = JSON.parse(
  readFileSync(require.resolve("@patrol/contract/schemas-bundle"), "utf8"),
) as SchemaBundle;

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);
for (const schema of Object.values(bundle.$defs)) {
  ajv.addSchema(schema);
}

const compiled = new Map<string, ValidateFunction>();

/**
 * Returns the compiled validator for one emitted schema name, cached per
 * `$id`. Throws when the name was never emitted, so an emitter gap fails
 * loudly instead of validating nothing.
 */
export function getValidator(name: string): ValidateFunction {
  const cached = compiled.get(name);
  if (cached) {
    return cached;
  }
  const validate = ajv.getSchema(`https://patrol.example/schemas/${name}.json`);
  if (!validate) {
    throw new Error(`schema ${name} was not emitted`);
  }
  compiled.set(name, validate);
  return validate;
}

/** Maps Ajv errors onto the contract's FieldError shape. */
function toFieldErrors(errors: ErrorObject[]): FieldError[] {
  return errors.map((error) => {
    let path = error.instancePath;
    if (path === "" && error.keyword === "required") {
      const missing = (error.params as { missingProperty?: string })
        .missingProperty;
      if (missing !== undefined) {
        path = `/${missing}`;
      }
    }
    return { path, message: error.message ?? "is invalid" };
  });
}

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Validates a request body against one emitted schema name and throws a
     * ValidationError carrying fieldErrors when it fails. Contract routes own
     * their validation here, never through fastify's built-in JSON schema.
     */
    validate: (body: unknown, schemaName: string) => unknown;
  }
}

/**
 * Wrapped with fastify-plugin so the decorator lands on the root instance
 * instead of an encapsulated child scope no route can see.
 */
export const validatorPlugin: FastifyPluginAsync = fp(
  async (app: FastifyInstance) => {
    app.decorate("validate", (body: unknown, schemaName: string) => {
      const validate = getValidator(schemaName);
      if (!validate(body)) {
        throw new ValidationError(toFieldErrors(validate.errors ?? []));
      }
      return body;
    });
  },
);
