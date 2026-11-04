export const GROUP = {
  name: "Russian classics",
  locales: ["ru-RU"],
  scanTime: "03:15",
  priority: "normal",
};

export function titleBody(
  titleGroupId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    titleGroupId,
    originalVariant: {
      text: "Ирония судьбы",
      language: "ru-RU",
      script: "Cyrl",
    },
    releaseYear: 1975,
    titleType: "film",
    runtimeMinutes: 184,
    additionalVariants: [],
    externalIdentifiers: [],
    source: "operator_knowledge",
    ...overrides,
  };
}
