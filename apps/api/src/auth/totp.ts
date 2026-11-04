import * as OTPAuth from "otpauth";

export interface TotpEnrollment {
  secret: string;
  uri: string;
}

export function createTotp(label: string): TotpEnrollment {
  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = new OTPAuth.TOTP({
    issuer: "Patrol",
    label,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret,
  });
  return { secret: secret.base32, uri: totp.toString() };
}

export function totpCode(secret: string, timestamp = Date.now()): string {
  return buildTotp(secret).generate({ timestamp });
}

export function verifyTotp(secret: string, code: string): boolean {
  try {
    return buildTotp(secret).validate({ token: code, window: 1 }) !== null;
  } catch {
    return false;
  }
}

function buildTotp(secret: string) {
  return new OTPAuth.TOTP({
    issuer: "Patrol",
    label: "operator",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}
