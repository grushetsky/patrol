import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalStatementText,
  loadStatementFixtures,
  templateHash12,
  templateIdentifier,
  verifyStatementFixture,
} from "../src/registry.js";
import { STATEMENT_SETS } from "../src/statements.js";

/**
 * Seam 1 (the template registry's hash and identifier): the
 * canonicalisation is the rules' EXACT algorithm — SHA-256 over a UTF-8
 * JSON array of ordered {key, text} objects, each text NFC, trimmed, and
 * every whitespace run collapsed, keys Patrol's own, interpolated values
 * excluded — and the fixture recomputation is the CI tripwire for drift.
 *
 * Every expected digest below is computed in the test from the algorithm's
 * description against an independently constructed canonical input, never
 * from the implementation's own output.
 */

/** SHA-256 over an exact canonical JSON string, truncated to twelve hex chars. */
function independentHash12(canonicalJson: string): string {
  return createHash("sha256").update(canonicalJson, "utf8").digest("hex").slice(0, 12);
}

describe("canonical statement text", () => {
  it("trims and collapses every whitespace run to one space", () => {
    expect(canonicalStatementText("  Hello \n\t world  ")).toBe("Hello world");
    expect(canonicalStatementText("single")).toBe("single");
  });

  it("normalises decomposed text to NFC", () => {
    // "cafe" + U+0301 COMBINING ACUTE ACCENT canonicalises to the
    // precomposed e-acute U+00E9; NFC composes the two code points.
    expect(canonicalStatementText("cafe\u0301")).toBe("caf\u00e9");
    expect(canonicalStatementText("cafe\u0301")).toHaveLength(4);
  });

  it("leaves already-canonical text untouched", () => {
    const text = "I have a good faith belief that use is not authorized.";
    expect(canonicalStatementText(text)).toBe(text);
  });
});

describe("the canonical set hash", () => {
  it("hashes the ordered array exactly as the rules describe", () => {
    const statements = [
      { key: "first", text: " One  statement " },
      { key: "second", text: "Another\tstatement" },
    ];
    // The canonical input, constructed independently of the implementation:
    // a UTF-8 JSON array of ordered {key, text} objects with each text
    // normalised, no insignificant whitespace, keys before text.
    const canonicalJson = JSON.stringify([
      { key: "first", text: "One statement" },
      { key: "second", text: "Another statement" },
    ]);
    expect(templateHash12(statements)).toBe(independentHash12(canonicalJson));
  });

  it("is order-sensitive: the same statements in a different order hash differently", () => {
    const a = [
      { key: "first", text: "One statement" },
      { key: "second", text: "Another statement" },
    ];
    const b = [a[1], a[0]];
    expect(templateHash12(a)).not.toBe(templateHash12(b));
  });

  it("ignores non-statement properties: interpolated values never enter the hash", () => {
    const base = [{ key: "k", text: "Statement text" }];
    // A caller passing extra properties (a label, an interpolated value)
    // cannot change the hash: only {key, text} participates.
    const decorated = [{ ...base[0], label: "Display label", value: "Signatory Name" }];
    expect(templateHash12(decorated)).toBe(templateHash12(base));
  });

  it("keeps the same hash12 for a label-only change (fields never enter the digest)", () => {
    // The registry's versioning basis: a field label change is a NEW
    // REVISION carrying the SAME hash — the digest runs over {key, text}
    // pairs alone, so the fields cannot move it.
    const [google] = loadStatementFixtures();
    const relabeled = google.statements.map((statement, index) =>
      index === 0 ? { ...statement, label: "A new display label" } : statement,
    );
    expect(templateHash12(relabeled)).toBe(google.expectedHash12);
  });

  it("treats whitespace-only differences as no difference", () => {
    const tidy = [{ key: "k", text: "The exact statement." }];
    const messy = [{ key: "k", text: "  The\t\texact\nstatement.  " }];
    expect(templateHash12(messy)).toBe(templateHash12(tidy));
  });
});

describe("the template identifier", () => {
  it("formats recipient slug, language, major, and hash12", () => {
    const statements = [{ key: "k", text: "Statement" }];
    const hash12 = templateHash12(statements);
    expect(
      templateIdentifier({ recipient: "google", language: "en", major: 1, statements }),
    ).toBe(`google-search.en.v1@${hash12}`);
    expect(
      templateIdentifier({ recipient: "bing", language: "en", major: 2, statements }),
    ).toBe(`bing.en.v2@${hash12}`);
    expect(
      templateIdentifier({ recipient: "yandex", language: "en", major: 3, statements }),
    ).toBe(`yandex.en.v3@${hash12}`);
  });

  it("uses the google-search slug for the google recipient", () => {
    const statements = [{ key: "k", text: "Statement" }];
    expect(
      templateIdentifier({ recipient: "google", language: "en", major: 1, statements }),
    ).toMatch(/^google-search\.en\.v1@[0-9a-f]{12}$/);
  });
});

describe("the checked-in fixtures (fixture drift)", () => {
  const fixtures = loadStatementFixtures();

  it("carries one fixture per verified statement set", () => {
    expect(new Set(fixtures.map((fixture) => fixture.identifier))).toEqual(
      new Set(STATEMENT_SETS.map(templateIdentifier)),
    );
  });

  it("recomputes each fixture's hash from its ordered statements", () => {
    for (const fixture of fixtures) {
      expect(templateHash12(fixture.statements)).toBe(fixture.expectedHash12);
    }
  });

  it("holds the exact identifiers the research verified on 2026-11-04", () => {
    expect(fixtures.map((fixture) => fixture.identifier)).toEqual([
      "google-search.en.v1@ed9f34155836",
      "bing.en.v1@e36eaf64fd3c",
      "yandex.en.v1@209722198e33",
    ]);
  });

  it("carries the labeled fields the fixtures' sets version, hash-excluded", () => {
    // The fields ride the fixture (and the seeded registry row) with their
    // label text, so a label-only change has a basis: a new revision row
    // with the SAME hash12.
    for (const fixture of fixtures) {
      expect(fixture.fields.length).toBeGreaterThan(0);
      for (const field of fixture.fields) {
        expect(field.label.trim()).not.toBe("");
        expect(typeof field.required).toBe("boolean");
      }
    }
    expect(fixtures[2].fields.map((field) => field.name)).toEqual(["signature", "date"]);
  });

  it("detects a tampered fixture: a drifted statement fails verification", () => {
    const tampered = fixtures.map((fixture) => ({ ...fixture }));
    tampered[0] = {
      ...tampered[0],
      statements: tampered[0].statements.map((statement, index) =>
        index === 0 ? { ...statement, text: `${statement.text} (edited)` } : statement,
      ),
    };
    const results = tampered.map(verifyStatementFixture);
    expect(results[0].ok).toBe(false);
    // The untampered sets still verify against their own expected hashes.
    expect(results.slice(1).every((result) => result.ok)).toBe(true);
  });

  it("detects an edited expected hash: the recomputation no longer matches", () => {
    const tampered = fixtures.map((fixture) => ({ ...fixture }));
    tampered[1] = { ...tampered[1], expectedHash12: "000000000000" };
    expect(verifyStatementFixture(tampered[1]).ok).toBe(false);
  });

  it("reads the fixture file from the package, beside the source", () => {
    const path = fileURLToPath(new URL("../src/fixtures/statement-templates.json", import.meta.url));
    const raw = JSON.parse(readFileSync(path, "utf8")) as { fixtures: unknown[] };
    expect(raw.fixtures).toHaveLength(3);
  });
});
