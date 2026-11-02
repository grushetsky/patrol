/**
 * Gap probe: validate payloads against the JSON Schema emitted for the
 * discriminated-union / inheritance variants in tsp-gaps/main.tsp.
 *
 * Expected values encode today's observed behaviour, including the defects
 * marked KNOWN DEFECT. If an emitter is fixed, this script starts failing and
 * the findings document must be updated.
 *
 * Run with: node --experimental-strip-types scripts/validate-gaps.ts
 */
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const bundle = JSON.parse(
  readFileSync(new URL("../generated/gaps/json-schema/gaps", import.meta.url), "utf8"),
) as { $defs: Record<string, { $id: string } & Record<string, unknown>> };

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const schema of Object.values(bundle.$defs)) ajv.addSchema(schema);

function validate(id: string, payload: unknown): boolean {
  const v = ajv.getSchema(`https://patrol.example/gaps/${id}.json`);
  if (!v) throw new Error(`missing schema ${id}`);
  return v(payload) as boolean;
}

const cases: Array<[string, string, unknown, boolean]> = [
  // `@discriminated` with envelope "none": union members are referenced
  // directly, but the discriminator property is not injected.
  ["KNOWN DEFECT: flat union rejects valid dog payload", "PetFlat", { kind: "dog", bark: true }, false],
  ["flat union, valid cat payload", "PetFlat", { kind: "cat", lives: 9 }, true],

  // `@discriminated` with the default envelope: serialized shape is
  // { kind, value }, but the JSON Schema emitter ignores the envelope.
  ["KNOWN DEFECT: envelope union rejects envelope payload", "PetEnvelope", { kind: "cat", value: { kind: "cat", lives: 9 } }, false],
  ["KNOWN DEFECT: envelope union accepts flat payload", "PetEnvelope", { kind: "cat", lives: 9 }, true],

  // Model inheritance + @discriminator + polymorphic-models-strategy: oneOf.
  ["inheritance, google notice", "NoticeBase", { channel: "google", id: "n1", retryCount: 0 }, true],
  ["KNOWN DEFECT: inheritance accepts unknown channel", "NoticeBase", { channel: "facebook", id: "n1" }, true],

  // Recursion.
  ["self reference", "SelfRef", { id: "u1", parent: { id: "u2" } }, true],
];

let failed = 0;
for (const [name, id, payload, expected] of cases) {
  const ok = validate(id, payload);
  const pass = ok === expected;
  if (!pass) failed += 1;
  console.log(`${pass ? "pass" : "FAIL"} | ${name} | ${id} -> ${ok} (expected ${expected})`);
}
if (failed > 0) {
  console.error(`${failed} case(s) behaved unexpectedly`);
  process.exitCode = 1;
}
