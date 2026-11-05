import { describe, expect, it } from "vitest";
import {
  YANDEX_ELIGIBLE_TERRITORIES,
  checkEligibility,
  resolveNoticeContent,
  type CitationFacts,
  type ProfileFacts,
  type RightsHolderFacts,
  type TemplateFacts,
} from "../src/compose.js";

/**
 * The composer's pure halves: the eligibility gate's territory rules and
 * the content resolver. The eligibility gate is the design's "Grouping per
 * recipient / Eligibility" with Yandex's CHANNEL FLOOR (US, Switzerland,
 * EU member states — the research's territory note) under the profile's
 * own list; the resolver is the pure function 6b's approval recomputes the
 * frozen content through, so the draft's stored values are never trusted.
 */

const profile = (eligibleTerritories: string[]): ProfileFacts => ({
  id: "profile-1",
  recipient: "yandex",
  channel: "web_form",
  account: "",
  contactEmail: null,
  eligibleTerritories,
  maxUrlsPerNotice: null,
  maxUrlsPerFile: null,
  lastObservedMaxUrlsPerFile: null,
});

const holder = (country: string): RightsHolderFacts => ({
  legalName: "Example Rights",
  country,
  address: "1 Street, Town",
  roleMailbox: "legal@example.test",
  phone: null,
  signatoryFullLegalName: "Anna Beispiel",
});

describe("Yandex eligibility: the channel floor under the profile's list", () => {
  it("holds the floor: the US, Switzerland, and the EU member states", () => {
    expect(YANDEX_ELIGIBLE_TERRITORIES).toContain("US");
    expect(YANDEX_ELIGIBLE_TERRITORIES).toContain("CH");
    // The EU-27, spot-checked from both ends of the alphabet.
    for (const member of ["AT", "BE", "DE", "FR", "IE", "MT", "SE"]) {
      expect(YANDEX_ELIGIBLE_TERRITORIES).toContain(member);
    }
    expect(YANDEX_ELIGIBLE_TERRITORIES).toHaveLength(29);
  });

  it("an empty territory list means the channel floor, not every territory", () => {
    // A rights holder outside the US/CH/EU set is ineligible even at the
    // default profile — the floor applies first.
    expect(checkEligibility("yandex", profile([]), holder("RU"))).toEqual({
      ok: false,
      reason: "territory",
    });
    expect(checkEligibility("yandex", profile([]), holder("BR"))).toEqual({
      ok: false,
      reason: "territory",
    });
  });

  it("a Swiss rights holder is eligible at the default profile", () => {
    expect(checkEligibility("yandex", profile([]), holder("CH"))).toEqual({ ok: true });
    // An EU member state rides the floor too.
    expect(checkEligibility("yandex", profile([]), holder("DE"))).toEqual({ ok: true });
  });

  it("the profile's territories can only narrow the floor", () => {
    // CH is inside the floor but outside the profile's list: ineligible.
    expect(checkEligibility("yandex", profile(["US"]), holder("CH"))).toEqual({
      ok: false,
      reason: "territory",
    });
    expect(checkEligibility("yandex", profile(["US", "CH"]), holder("CH"))).toEqual({ ok: true });
    // A profile listing only non-floor territories cannot widen the floor.
    expect(checkEligibility("yandex", profile(["RU", "CN"]), holder("RU"))).toEqual({
      ok: false,
      reason: "territory",
    });
  });
});

const template: TemplateFacts = {
  identifier: "google-search.en.v1@ed9f34155836",
  statements: [
    { key: "good_faith_belief", text: "First statement." },
    { key: "accuracy_perjury_authority", text: "Second statement." },
  ],
};

const citations: CitationFacts[] = [
  {
    violationId: "v-1",
    trackedTitleId: "title-a",
    displayTitle: "Sunrise",
    releaseYear: 2024,
    titleType: "film",
  },
  {
    violationId: "v-2",
    trackedTitleId: "title-a",
    displayTitle: "Sunrise",
    releaseYear: 2024,
    titleType: "film",
  },
  {
    violationId: "v-3",
    trackedTitleId: "title-b",
    displayTitle: "Moonlight",
    releaseYear: 2023,
    titleType: "series",
  },
];

describe("the content resolver (the freeze's pure half)", () => {
  it("renders the resolved field map and one work identification per cited title", () => {
    const content = resolveNoticeContent({
      recipient: "google",
      template,
      rightsHolder: holder("DE"),
      citations,
    });
    expect(content.templateVersion).toBe(template.identifier);
    expect(content.statements).toEqual(template.statements);
    expect(content.workIdentifications).toEqual([
      { trackedTitleId: "title-a", displayTitle: "Sunrise", releaseYear: 2024, titleType: "film" },
      { trackedTitleId: "title-b", displayTitle: "Moonlight", releaseYear: 2023, titleType: "series" },
    ]);
    expect(
      content.resolvedFields.find((field) => field.name === "copyright_owner")?.value,
    ).toBe("Example Rights");
    expect(content.resolvedFields.find((field) => field.name === "signature")?.value).toBe(
      "Anna Beispiel",
    );
  });

  it("yields updated fields when the rights holder changed after the draft", () => {
    // The draft was composed under one rights holder; the holder's facts
    // then changed. Approval (6b) recomputes through this function from
    // FRESH reads — the recomputed content carries the new facts, never
    // the draft's stored values.
    const renamed: RightsHolderFacts = {
      ...holder("DE"),
      legalName: "Renamed Rights AG",
      signatoryFullLegalName: "Beispiel Anna",
    };
    const recomputed = resolveNoticeContent({
      recipient: "google",
      template,
      rightsHolder: renamed,
      citations,
    });
    expect(
      recomputed.resolvedFields.find((field) => field.name === "copyright_owner")?.value,
    ).toBe("Renamed Rights AG");
    expect(recomputed.resolvedFields.find((field) => field.name === "signature")?.value).toBe(
      "Beispiel Anna",
    );
  });
});
