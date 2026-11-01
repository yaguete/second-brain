import crypto from "crypto";
import express from "express";
import { OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_REDIRECT_URIS } from "./config.js";
import { clientIp, failureCount, recordAuthFailure } from "./middleware/auth.js";
import { secretsEqual } from "./shared/secrets.js";
import { issueTokenPair, rotateRefreshToken } from "./shared/tokens.js";

const CODE_TTL_MS = 5 * 60 * 1000;
const authCodes = new Map();

function cleanExpiredCodes(now = Date.now()) {
  for (const [code, entry] of authCodes) {
    if (now - entry.createdAt > CODE_TTL_MS) authCodes.delete(code);
  }
}

function redirectAllowed(uri) {
  return OAUTH_REDIRECT_URIS.some((allowed) => allowed === uri);
}

export function mountOAuthBridge(app) {
  app.get("/authorize", (req, res) => {
    const ip = clientIp(req);
    if (failureCount(ip) >= 10) return res.status(429).json({ error: "too_many_attempts" });

    const { client_id, redirect_uri, response_type, state } = req.query;
    if (response_type !== "code") return res.status(400).json({ error: "unsupported response_type, must be 'code'" });
    if (!secretsEqual(String(client_id || ""), OAUTH_CLIENT_ID)) {
      recordAuthFailure(ip);
      return res.status(400).json({ error: "invalid client_id" });
    }
    if (!redirect_uri || !redirectAllowed(String(redirect_uri))) {
      return res.status(400).json({ error: "redirect_uri is not allowed" });
    }

    cleanExpiredCodes();
    const code = crypto.randomBytes(32).toString("hex");
    authCodes.set(code, { redirectUri: String(redirect_uri), createdAt: Date.now() });

    const url = new URL(String(redirect_uri));
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", String(state));
    res.redirect(url.toString());
  });

  app.use("/token", express.urlencoded({ extended: false }));

  app.post("/token", (req, res) => {
    const ip = clientIp(req);
    if (failureCount(ip) >= 10) return res.status(429).json({ error: "too_many_attempts" });

    const { grant_type, code, client_id, client_secret, redirect_uri, refresh_token } = req.body || {};
    if (grant_type !== "authorization_code" && grant_type !== "refresh_token") {
      return res.status(400).json({ error: "unsupported_grant_type" });
    }
    if (!secretsEqual(String(client_id || ""), OAUTH_CLIENT_ID)) {
      recordAuthFailure(ip);
      return res.status(400).json({ error: "invalid_client" });
    }
    if (!OAUTH_CLIENT_SECRET) {
      return res.status(500).json({ error: "OAUTH_CLIENT_SECRET not configured" });
    }
    if (!secretsEqual(String(client_secret || ""), OAUTH_CLIENT_SECRET)) {
      recordAuthFailure(ip);
      return res.status(401).json({ error: "invalid_client_secret" });
    }

    if (grant_type === "refresh_token") {
      const next = rotateRefreshToken(String(refresh_token || ""));
      if (!next) {
        recordAuthFailure(ip);
        return res.status(400).json({ error: "invalid_grant", error_description: "invalid refresh_token" });
      }
      return res.json(next);
    }

    cleanExpiredCodes();
    const entry = authCodes.get(String(code || ""));
    if (!entry) return res.status(400).json({ error: "invalid_grant", error_description: "code expired or already used" });
    if (entry.redirectUri !== redirect_uri) {
      return res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
    }
    if (!redirectAllowed(entry.redirectUri)) {
      return res.status(400).json({ error: "redirect_uri is not allowed" });
    }

    authCodes.delete(String(code || ""));
    return res.json(issueTokenPair({ scope: "write" }));
  });
}
