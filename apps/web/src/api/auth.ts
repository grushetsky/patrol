import { api, ApiError, ensureCsrf } from "./client";
import type { components } from "../generated/openapi";

type Schemas = components["schemas"];
export type SignedIn = Schemas["Http.AuthenticatedSession"];
export type SecondFactorChallenge = Schemas["Http.SecondFactorChallenge"];
export type EnrollmentCeremony = Schemas["Http.EnrollmentCeremony"];
export type TotpEnrollment = Schemas["Http.TotpEnrollment"];
export type RegistrationCompleted = Schemas["Http.RegistrationCompleted"];

async function csrfParams() {
  return { header: { "X-Patrol-CSRF": await ensureCsrf() } };
}

export async function signIn(
  email: string,
  password: string,
): Promise<SecondFactorChallenge> {
  const result = await api.POST("/auth/sign-in", {
    body: { email, password },
    params: await csrfParams(),
  });
  if (result.error || !result.data) {
    throw new ApiError(0, result.error);
  }
  return result.data;
}

export async function verifySecondFactor(
  challengeId: string,
  code: string,
  method: "totp" | "recovery_code",
): Promise<SignedIn> {
  const result = await api.POST("/auth/second-factor", {
    body: { challengeId, code, method },
    params: await csrfParams(),
  });
  if (result.error || !result.data) {
    throw new ApiError(0, result.error);
  }
  return result.data;
}

export async function setupAccount(
  token: string,
  password: string,
): Promise<EnrollmentCeremony> {
  const result = await api.POST("/auth/setup", {
    body: { token, password },
    params: await csrfParams(),
  });
  if (result.error || !result.data) {
    throw new ApiError(0, result.error);
  }
  return result.data;
}

export async function startEnrollment(
  enrollmentToken: string,
): Promise<TotpEnrollment> {
  const result = await api.POST("/auth/enrollment", {
    body: { enrollmentToken },
    params: await csrfParams(),
  });
  if (result.error || !result.data) {
    throw new ApiError(0, result.error);
  }
  return result.data;
}

export async function confirmEnrollment(
  enrollmentToken: string,
  code: string,
): Promise<RegistrationCompleted> {
  const result = await api.POST("/auth/enrollment/confirmation", {
    body: { enrollmentToken, code },
    params: await csrfParams(),
  });
  if (result.error || !result.data) {
    throw new ApiError(0, result.error);
  }
  return result.data;
}

export async function signOut(csrfToken: string): Promise<void> {
  const result = await api.DELETE("/auth/session", {
    params: { header: { "X-Patrol-CSRF": csrfToken } },
  });
  if (result.error) {
    throw new ApiError(0, result.error);
  }
}

export async function updateLanguage(
  language: "en" | "ru",
  csrfToken: string,
) {
  const result = await api.PATCH("/auth/preferences", {
    body: { language },
    params: { header: { "X-Patrol-CSRF": csrfToken } },
  });
  if (result.error || !result.data) {
    throw new ApiError(0, result.error);
  }
  return result.data;
}
