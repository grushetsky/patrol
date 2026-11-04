import { readFile } from "node:fs/promises";
import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export interface FieldIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: FieldIssue[];
}

export interface Contract {
  validate(name: string, value: unknown): ValidationResult;
}

interface SchemaBundle {
  $defs: Record<string, { $id?: string } & Record<string, unknown>>;
}

const SCHEMA_BASE = "https://patrol.example/schemas/";

export async function loadContract(
  bundlePath: string | URL,
): Promise<Contract> {
  const bundle = JSON.parse(
    await readFile(bundlePath, "utf8"),
  ) as SchemaBundle;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const schema of Object.values(bundle.$defs)) {
    if (schema.$id) {
      ajv.addSchema(schema);
    }
  }

  return {
    validate(name, value) {
      const check = ajv.getSchema(`${SCHEMA_BASE}${name}.json`);
      if (!check) {
        throw new Error(`contract schema ${name} was not emitted`);
      }
      const valid = check(value) as boolean;
      return {
        valid,
        issues: valid ? [] : (check.errors ?? []).map(toIssue),
      };
    },
  };
}

function toIssue(error: ErrorObject): FieldIssue {
  return {
    path: error.instancePath || "/",
    message: error.message ?? "invalid",
  };
}
