/**
 * Round-trip check: validate wire payloads against the JSON Schema bundle that
 * `@typespec/json-schema` emitted, using Ajv 2020-12.
 *
 * Run with: node --experimental-strip-types scripts/validate-node.ts
 */
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const bundlePath = new URL("../generated/json-schema/patrol", import.meta.url);
const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as {
  $defs: Record<string, { $id: string } & Record<string, unknown>>;
};

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

// The bundle keeps absolute $id refs across $defs. Register every definition
// under its own $id so `getSchema(<$id>)` returns the concrete validator; the
// root document (`$id: "patrol"`) itself carries no validation constraints.
for (const schema of Object.values(bundle.$defs)) {
  ajv.addSchema(schema);
}

function validator(id: string) {
  const validate = ajv.getSchema(`https://patrol.example/schemas/${id}.json`);
  if (!validate) throw new Error(`schema not registered: ${id}`);
  return validate;
}

const results: Array<{ case: string; schema: string; ok: boolean; expected: boolean }> = [];

function check(caseName: string, schemaId: string, payload: unknown, expected: boolean) {
  const ok = validator(schemaId)(payload) as boolean;
  results.push({ case: caseName, schema: schemaId, ok, expected });
}

const violation = {
  id: "3f1c0a5e-6b1d-4a1e-9a5f-2f0f7f4a9c11",
  titleId: "title-1",
  status: "open",
  confidence: "low",
  detectedAt: "2026-11-03T00:00:00Z",
  sourceUrl: "https://example.com/watch?v=1",
  evidence: [
    {
      id: "ev-1",
      kind: "screenshot",
      capturedAt: "2026-11-03T00:00:00Z",
      sha256: "abc",
      derivedFrom: {
        id: "ev-0",
        kind: "html",
        capturedAt: "2026-11-02T00:00:00Z",
        sha256: "def",
      },
    },
  ],
};

const dmca = {
  channel: "google",
  id: "6c1c0a5e-6b1d-4a1e-9a5f-2f0f7f4a9c22",
  violationId: violation.id,
  retryCount: 0,
};

const { status: _status, ...violationNoStatus } = violation;
const { channel: _channel, ...dmcaNoChannel } = dmca;

check("Violation, recursive evidence", "Violation", violation, true);
check("Violation without defaulted status", "Violation", violationNoStatus, false);
check("Violation with unknown status", "Violation", { ...violation, status: "archived" }, false);
check("Notice WITH channel discriminator", "Notice", dmca, true);
check("Notice WITHOUT channel", "Notice", dmcaNoChannel, false);
check("CreateNoticeRequest valid", "CreateNoticeRequest", {
  violationId: violation.id,
  channel: "google",
}, true);

let failed = 0;
for (const r of results) {
  const pass = r.ok === r.expected;
  if (!pass) failed += 1;
  console.log(`${pass ? "pass" : "FAIL"} | ${r.case} | ${r.schema} -> ${r.ok} (expected ${r.expected})`);
}
if (failed > 0) {
  console.error(`${failed} case(s) behaved unexpectedly`);
  process.exitCode = 1;
}
