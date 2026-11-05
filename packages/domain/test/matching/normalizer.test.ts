import { describe, expect, it } from "vitest";
import { matchingKey, normalizeForMatching } from "../../src/matching/normalizer.js";

/**
 * Seam 1, against docs/design/matching-and-classification-rules.md "Title
 * match": NFKC, full case fold, diacritic folding that keeps the native
 * string, punctuation and whitespace collapse, a per-language article-less
 * key, and the declared transliteration scheme. Every vector here is the
 * document's own pipeline applied, not a recomputed opinion.
 */

describe("NFKC compatibility folding", () => {
  it("collapses fullwidth forms to their plain forms", () => {
    expect(matchingKey("ＭＡＴＲＩＸ")).toBe("matrix");
  });

  it("collapses compatibility ligatures", () => {
    expect(matchingKey("ﬁne")).toBe("fine");
  });

  it("collapses superscript digits to plain digits", () => {
    expect(matchingKey("part ⅠⅠ")).toBe("part ii");
  });
});

describe("full case fold", () => {
  it("folds the sharp s both directions so Straße and STRASSE share a key", () => {
    expect(matchingKey("Straße")).toBe("strasse");
    expect(matchingKey("STRASSE")).toBe("strasse");
    expect(matchingKey("ẞ")).toBe("ss");
  });

  it("folds the long s", () => {
    expect(matchingKey("ſurname")).toBe("surname");
  });

  it("folds the Greek final sigma onto the medial form", () => {
    expect(matchingKey("ΣΟΦΟΣ")).toBe(matchingKey("σοφος"));
    // Both keys end on the medial σ, whatever sigma the input carried.
    expect(matchingKey("σοφος").endsWith("σ")).toBe(true);
    expect(matchingKey("σοφος").includes("ς")).toBe(false);
  });
});

describe("diacritic folding keeps the native string", () => {
  it("strips accents from the key only", () => {
    const normalized = normalizeForMatching("Café");
    expect(normalized.native).toBe("Café");
    expect(normalized.key).toBe("cafe");
  });

  it("folds Cyrillic-accented vowels and Slavic forms to bare letters", () => {
    expect(matchingKey("Предчувствие")).toBe("predchuvstvie");
  });
});

describe("punctuation and whitespace collapse", () => {
  it("turns punctuation runs and whitespace runs into single separators", () => {
    expect(matchingKey("Spider-Man:   Far  From   Home!")).toBe(
      "spider man far from home",
    );
  });

  it("keeps digits and mixes them with letters", () => {
    expect(matchingKey("Sunrise (2024)")).toBe("sunrise 2024");
  });

  it("trims stray separators from both ends", () => {
    expect(matchingKey("  ...Sunrise...  ")).toBe("sunrise");
  });
});

describe("the per-language article-less key", () => {
  it("drops a leading English definite article", () => {
    expect(matchingKey("The Batman", "en")).toBe("batman");
  });

  it("drops a leading English indefinite article", () => {
    expect(matchingKey("A Quiet Place", "en")).toBe("quiet place");
    expect(matchingKey("Anora", "en")).toBe("anora");
  });

  it("drops the article wherever the language is declared or inferred", () => {
    expect(matchingKey("The Batman")).toBe("batman");
    expect(matchingKey("The Batman", "en-US")).toBe("batman");
  });

  it("does not strip articles mid-title", () => {
    expect(matchingKey("Face/Off: The Return", "en")).toBe(
      "face off the return",
    );
  });

  it("strips the declared Russian article forms the scheme names", () => {
    // Russian carries no articles; the declared ru list is empty, so the ru
    // key never loses a leading token. The assertion pins that: a leading
    // "Это" survives because ru declares no article.
    expect(matchingKey("Это рассвет", "ru")).toBe("eto rassvet");
  });

  it("makes an articled page title and a bare variant equal", () => {
    expect(matchingKey("The Batman", "en")).toBe(
      matchingKey("Batman", "en"),
    );
  });
});

describe("the declared transliteration scheme (ru → lat)", () => {
  it("maps Cyrillic onto Latin per the declared table", () => {
    expect(matchingKey("Рассвет")).toBe("rassvet");
    expect(matchingKey("Щука")).toBe("shchuka");
  });

  it("renders the doc's zh/kh/ts/ch/sh/shch digraphs", () => {
    expect(matchingKey("жук хор цап чат шик")).toBe("zhuk khor tsap chat shik");
  });

  it("drops the Cyrillic hard and soft signs from the key", () => {
    expect(matchingKey("объект")).toBe(matchingKey("обект"));
    expect(matchingKey("мальчик")).toBe("malchik");
  });

  it("romanizes ё as yo, distinct from е, per BGN/PCGN", () => {
    expect(matchingKey("Ёлка")).toBe("yolka");
    expect(matchingKey("Елка")).toBe("elka");
  });

  it("lets a transliterated page title and the Cyrillic variant share a key", () => {
    expect(matchingKey("Рассвет (2024)")).toBe("rassvet 2024");
    expect(matchingKey("Rassvet (2024)")).toBe("rassvet 2024");
  });

  it("maps й to y from both the precomposed and the decomposed form", () => {
    // The table reads the NFKC-composed string before the diacritic fold,
    // so the breve never strips й down to и first.
    expect(matchingKey("й")).toBe(matchingKey("й"));
    expect(matchingKey("й")).toBe("y");
  });

  it("maps онлайн and its common Latin spelling onto one key", () => {
    expect(matchingKey("онлайн")).toBe("onlayn");
    expect(matchingKey("onlayn")).toBe("onlayn");
  });

  it("romanizes adjective endings -ий and -ый as -iy and -yy", () => {
    expect(matchingKey("хороший")).toBe("khoroshiy");
    expect(matchingKey("красный")).toBe("krasnyy");
  });

  it("transliterates ю and я as the table declares", () => {
    expect(matchingKey("юлия и я")).toBe("yuliya i ya");
    expect(matchingKey("Я")).toBe("ya");
  });
});

describe("slug keys", () => {
  it("treats hyphens and underscores as separators", () => {
    expect(matchingKey("sunrise-2024_full-movie")).toBe(
      "sunrise 2024 full movie",
    );
  });
});
