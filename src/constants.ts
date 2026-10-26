// min length 1
const v = (s?: string) => (s ?? "").trim();
export const LOGIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const GRANT_MAX_TTL_SECONDS = 300;
export const MAGIC_LINK_TTL_SECONDS = 15 * 60;
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const ENROLLMENT_TTL_SECONDS = 10 * 60;
export const RATE_WINDOW_SECONDS = 60 * 60;

export function isProduction(env: Record<string, string | undefined>): boolean {
  return v(env.CORE_ENV).toLowerCase() === "production";
}

export function publicBaseUrl(env: Record<string, string | undefined>): string {
  return v(env.CORE_PUBLIC_BASE_URL) || "http://127.0.0.1:8787";
}

export function jwtIssuer(env: Record<string, string | undefined>): string {
  return v(env.CORE_JWT_ISSUER) || publicBaseUrl(env);
}
