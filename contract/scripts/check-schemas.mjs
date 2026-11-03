import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const bundlePath = new URL("../generated/json-schema/patrol-domain", import.meta.url);
const bundle = JSON.parse(await readFile(bundlePath, "utf8"));

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

for (const schema of Object.values(bundle.$defs)) ajv.addSchema(schema);

const ref = (name) => `https://patrol.example/schemas/${name}.json`;
const validate = (name, value) => {
  const check = ajv.getSchema(ref(name));
  if (!check) throw new Error(`schema ${name} is not emitted`);
  return check(value);
};

const id = (n) => `018f4c8e-1c2a-7c3e-9b1f-2b6d9f0a3c${String(n).padStart(2, "0")}`;
const at = "2026-11-03T10:00:00Z";
const sha = "a".repeat(64);

const address = {
  line1: "1 Example Street",
  city: "Exampleville",
  postalCode: "10001",
  country: "US",
};

const approvedNotice = {
  state: "approved",
  approvedBy: id(1),
  approvedAt: at,
  rightsHolder: {
    legalName: "Example Rights Holder",
    country: "US",
    address,
    roleMailbox: "legal@example.test",
    capturedAt: at,
  },
  signatory: {
    fullLegalName: "Example Signatory",
    authorityBasis: "Copyright owner",
    contactEmail: "signatory@example.test",
    capturedAt: at,
  },
  profile: {
    profileId: id(2),
    version: 1,
    channel: "web_form",
    account: "ops@example.test",
    capturedAt: at,
  },
};

const searchResult = {
  id: id(3),
  scanId: id(4),
  queryId: id(5),
  engine: "google",
  url: "https://www.example.test/watch",
  normalizedUrl: "example.test/watch",
  rank: 1,
  title: "Example Work",
  snippet: "Watch Example Work online",
  locale: "en-US",
  observedAt: at,
  rawPayloadRef: "serp/google/2026/11/x.json.gz",
  host: "example.test",
  registrableDomain: "example.test",
};

const artifact = {
  kind: "screenshot",
  sha256: sha,
  byteSize: 1024,
  contentType: "image/png",
  truncated: false,
};

const titleVariant = {
  id: id(6),
  trackedTitleId: id(7),
  text: "Пример",
  normalizedText: "пример",
  kind: "original",
  language: "ru",
  script: "Cyrl",
  source: "operator_knowledge",
  addedBy: id(1),
  addedAt: at,
};

const cases = [
  ["approved notice with snapshots", "ApprovedNotice", approvedNotice, true],
  ["approved notice without the approver or snapshots", "ApprovedNotice", { state: "approved" }, false],
  ["closed violation without the closer", "ClosedViolation", { state: "closed", closedAt: at, reason: "operator_closed" }, false],
  [
    "closed violation with the closer",
    "ClosedViolation",
    { state: "closed", closedAt: at, reason: "operator_closed", closedBy: id(1) },
    true,
  ],
  ["failed scan without a reason", "FailedScan", { state: "failed", finishedAt: at }, false],
  ["failed scan with a reason", "FailedScan", { state: "failed", finishedAt: at, failureReason: "route_unavailable" }, true],
  ["pending candidate lifecycle", "PendingCandidate", { state: "pending" }, true],
  ["confirmed candidate without its violation", "ConfirmedCandidate", { state: "confirmed" }, false],
  [
    "acknowledged submission without an acknowledgement",
    "AcknowledgedSubmission",
    { state: "acknowledged", operatorId: id(1), deliveredAt: at, attestation: { attestedAt: at, statementVersion: "1" } },
    false,
  ],
  ["rank below one", "SearchResult", { ...searchResult, rank: 0 }, false],
  ["rank at one", "SearchResult", searchResult, true],
  ["malformed SHA-256", "EvidenceArtifact", { ...artifact, sha256: "not-a-hash" }, false],
  ["well-formed SHA-256", "EvidenceArtifact", artifact, true],
  ["malformed email", "Email", "not-an-email", false],
  ["well-formed email", "Email", "operator@example.test", true],
  ["unknown title type", "TitleType", "movie", false],
  ["known title type", "TitleType", "film", true],
  ["draft carrying approval fields", "DraftNotice", { state: "draft", approvedBy: id(1) }, false],
  ["draft alone", "DraftNotice", { state: "draft" }, true],
  ["title variant", "TitleVariant", titleVariant, true],
  ["negative monthly cap", "EngineBudgetCap", { engine: "google", currency: "usd", monthlyCapMinor: -1, monthlyAllowanceUnits: 0 }, false],
];

const failures = [];
for (const [label, schema, value, expected] of cases) {
  const valid = validate(schema, value);
  const ok = valid === expected;
  console.log(`${ok ? "ok" : "FAIL"}  ${label} (${schema} ${expected ? "accepts" : "rejects"})`);
  if (!ok) failures.push({ label, schema, expected, errors: ajv.errors });
}

if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exit(1);
}

console.log(`${cases.length} schema checks passed against ${Object.keys(bundle.$defs).length} emitted definitions.`);
