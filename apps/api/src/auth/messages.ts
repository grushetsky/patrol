export type MessageLanguage = "en" | "ru";

const MESSAGES: Record<string, Record<MessageLanguage, string>> = {
  unauthenticated: { en: "No valid session.", ru: "Нет действующей сессии." },
  forbidden: { en: "The request is not allowed.", ru: "Запрос не разрешён." },
  invalid_credentials: { en: "The email or password is wrong.", ru: "Неверный адрес или пароль." },
  invalid_second_factor: { en: "The code is wrong.", ru: "Неверный код." },
  account_locked: { en: "The account is locked.", ru: "Учётная запись заблокирована." },
  challenge_expired: { en: "The sign-in challenge expired.", ru: "Срок входа истёк." },
  setup_required: { en: "The deployment is not bootstrapped.", ru: "Развёртывание не настроено." },
  validation_failed: { en: "The request body is invalid.", ru: "Некорректные данные запроса." },
  state_conflict: { en: "The request conflicts with the current state.", ru: "Запрос конфликтует с текущим состоянием." },
  duplicate_entity: { en: "The record already exists.", ru: "Запись уже существует." },
  last_administrator: { en: "The last administrator cannot be changed.", ru: "Последнего администратора нельзя изменить." },
  not_found: { en: "The record was not found.", ru: "Запись не найдена." },
  invitation_invalid: { en: "The token is not valid.", ru: "Токен недействителен." },
  invitation_expired: { en: "The token expired.", ru: "Срок действия токена истёк." },
  rate_limited: { en: "Too many attempts.", ru: "Слишком много попыток." },
  internal_error: { en: "Internal server error.", ru: "Внутренняя ошибка сервера." },
};

export function resolveLanguage(header: string | string[] | undefined): MessageLanguage {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (!value) {
    return "en";
  }
  for (const part of value.split(",")) {
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

export function localize(
  code: string,
  language: MessageLanguage,
  fallback: string,
): string {
  return MESSAGES[code]?.[language] ?? fallback;
}
