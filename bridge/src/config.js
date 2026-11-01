export const YNAB_TOKEN = process.env.YNAB_API_TOKEN;
export const API_KEY = process.env.BRIDGE_API_KEY || "";
export const READ_KEY = process.env.BRIDGE_READ_KEY || "";
export const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || "";
export const YNAB_BASE = "https://api.ynab.com/v1";
export const WITHINGS_CLIENT_ID = process.env.WITHINGS_CLIENT_ID;
export const WITHINGS_CLIENT_SECRET = process.env.WITHINGS_CLIENT_SECRET;
export const WITHINGS_REDIRECT_URI = process.env.WITHINGS_REDIRECT_URI;
export const WITHINGS_SCOPE_RAW = process.env.WITHINGS_SCOPE || "metrics,activity";
export const WITHINGS_API = "https://wbsapi.withings.net/v2";
export const WITHINGS_AUTH_BASE = "https://account.withings.com/oauth2_user/authorize2";
export const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || "second-brain";
export const OAUTH_REDIRECT_URIS = (process.env.OAUTH_REDIRECT_URIS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const ENABLED_MODULES = (process.env.ENABLED_MODULES || "brain")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const DATABASE_SSL = process.env.DATABASE_SSL === "true";
export const TRUST_PROXY = process.env.TRUST_PROXY === "1";
export const ACCESS_TOKEN_TTL_MS = Number(process.env.ACCESS_TOKEN_TTL_MS || 60 * 60 * 1000);
export const REFRESH_TOKEN_TTL_MS = Number(process.env.REFRESH_TOKEN_TTL_MS || 30 * 24 * 60 * 60 * 1000);
export const PORT = process.env.PORT || 3000;

const KEY_HINT = "Generate one with: openssl rand -base64 32";

export function keyByteLength(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

/** Returns { ok:false, error } instead of exiting, so tests can call it. */
export function bootConfig(env = process.env) {
  const master = env.BRIDGE_API_KEY || "";
  if (keyByteLength(master) < 32) {
    return { ok: false, error: `BRIDGE_API_KEY must be at least 32 bytes. ${KEY_HINT}` };
  }
  if (env.BRIDGE_READ_KEY && keyByteLength(env.BRIDGE_READ_KEY) < 32) {
    return { ok: false, error: `BRIDGE_READ_KEY must be at least 32 bytes. ${KEY_HINT}` };
  }
  if (env.OAUTH_CLIENT_SECRET && keyByteLength(env.OAUTH_CLIENT_SECRET) < 32) {
    return { ok: false, error: `OAUTH_CLIENT_SECRET must be at least 32 bytes. ${KEY_HINT}` };
  }
  return { ok: true };
}
