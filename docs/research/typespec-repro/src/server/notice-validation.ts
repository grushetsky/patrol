import { readFileSync } from "node:fs";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

interface SchemaBundle {
  $defs: Record<string, { $id: string } & Record<string, unknown>>;
}

/** Serialisable subset of an Ajv error, safe to cross the server-fn boundary. */
export interface ValidationIssue {
  instancePath: string;
  keyword: string;
  message?: string;
}

export interface NoticeValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

// The emitted bundle keeps absolute $id refs across $defs, so register every
// definition under its own $id instead of compiling the bundle root.
const bundle = JSON.parse(
  readFileSync(
    new URL("../../generated/json-schema/patrol", import.meta.url),
    "utf8",
  ),
) as SchemaBundle;

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const schema of Object.values(bundle.$defs)) {
  ajv.addSchema(schema);
}

const validateSchema: ValidateFunction = (() => {
  const validate = ajv.getSchema(
    "https://patrol.example/schemas/CreateNoticeRequest.json",
  );
  if (!validate) {
    throw new Error("CreateNoticeRequest schema was not emitted");
  }
  return validate;
})();

export function validateCreateNotice(body: unknown): NoticeValidationResult {
  const ok = validateSchema(body) as boolean;
  return {
    ok,
    issues: ok ? [] : (validateSchema.errors ?? []).map(toIssue),
  };
}

function toIssue(error: ErrorObject): ValidationIssue {
  const issue: ValidationIssue = {
    instancePath: error.instancePath,
    keyword: error.keyword,
  };
  if (error.message !== undefined) {
    issue.message = error.message;
  }
  return issue;
}
