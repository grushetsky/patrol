import { readFileSync } from "node:fs";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

interface SchemaBundle {
  $defs: Record<string, { $id: string } & Record<string, unknown>>;
}

/** A serialisable subset of an Ajv error, safe to cross a server boundary. */
export interface ValidationIssue {
  instancePath: string;
  keyword: string;
  message?: string;
}

const bundle = JSON.parse(
  readFileSync(
    new URL("../../../generated/json-schema/patrol", import.meta.url),
    "utf8",
  ),
) as SchemaBundle;

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const schema of Object.values(bundle.$defs)) {
  ajv.addSchema(schema);
}

function compile(name: string): ValidateFunction {
  const validate = ajv.getSchema(
    `https://patrol.example/schemas/${name}.json`,
  );
  if (!validate) {
    throw new Error(`schema ${name} was not emitted`);
  }
  return validate;
}

/** The request body of POST /candidates/{candidateId}/review-decisions. */
export const validateReviewDecisionRequest = compile("ReviewDecisionRequest");

/** The response body of POST /candidates/{candidateId}/review-decisions. */
export const validateReviewDecisionResult = compile("ReviewDecisionResult");

/** The body every error response carries. */
export const validateErrorBody = compile("ErrorBody");

export function issues(validate: ValidateFunction): ValidationIssue[] {
  return (validate.errors ?? []).map(toIssue);
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
