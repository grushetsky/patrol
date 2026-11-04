export const en = {
  appTitle: "Patrol",
  dashboard: "Dashboard",
  review: "Review",
  violations: "Violations",
  notices: "Notices",
  titles: "Titles",
  settings: "Settings",
  runScans: "Run scans",
  reviewQueue: "Review queue",
  version: "Contract version",
  connected: "API connected",
} as const;

export type MessageKey = keyof typeof en;
export type Language = "en" | "ru";

export const ru: Record<MessageKey, string> = {
  appTitle: "Патруль",
  dashboard: "Обзор",
  review: "Проверка",
  violations: "Нарушения",
  notices: "Уведомления",
  titles: "Произведения",
  settings: "Настройки",
  runScans: "Запустить сканирование",
  reviewQueue: "Очередь проверки",
  version: "Версия контракта",
  connected: "API подключён",
};

const catalogues: Record<Language, Record<MessageKey, string>> = { en, ru };

/** Resolve the interface language from an `Accept-Language` header. */
export function resolveLanguage(acceptLanguage: string | undefined | null): Language {
  if (!acceptLanguage) {
    return "en";
  }
  for (const part of acceptLanguage.split(",")) {
    const tag = part.split(";")[0]?.trim().toLowerCase() ?? "";
    if (tag === "ru" || tag.startsWith("ru-")) {
      return "ru";
    }
    if (tag === "en" || tag.startsWith("en-")) {
      return "en";
    }
  }
  return "en";
}

export function translate(language: Language, key: MessageKey): string {
  return catalogues[language][key];
}
