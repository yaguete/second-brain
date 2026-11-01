import crypto from "crypto";
import { ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS } from "../config.js";
import { digestToken } from "./secrets.js";

const access = new Map();
const refresh = new Map();

export function resetTokenStore() {
  access.clear();
  refresh.clear();
}

export function issueTokenPair({
  scope,
  now = Date.now(),
  accessTtlMs = ACCESS_TOKEN_TTL_MS,
  refreshTtlMs = REFRESH_TOKEN_TTL_MS
} = {}) {
  const accessToken = crypto.randomBytes(32).toString("hex");
  const refreshToken = crypto.randomBytes(32).toString("hex");
  access.set(digestToken(accessToken), { scope, expiresAt: now + accessTtlMs });
  refresh.set(digestToken(refreshToken), { scope, expiresAt: now + refreshTtlMs });
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.floor(accessTtlMs / 1000),
    refresh_token: refreshToken
  };
}

export function lookupAccessToken(token, now = Date.now()) {
  const row = access.get(digestToken(token));
  if (!row || row.expiresAt <= now) return null;
  return row;
}

/** Returns a new pair and invalidates the presented refresh token. */
export function rotateRefreshToken(token, now = Date.now(), ttls = {}) {
  const key = digestToken(token);
  const row = refresh.get(key);
  if (!row || row.expiresAt <= now) return null;
  refresh.delete(key);
  return issueTokenPair({ scope: row.scope, now, ...ttls });
}
