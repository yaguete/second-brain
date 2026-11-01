import { API_KEY, READ_KEY, TRUST_PROXY } from "../config.js";
import { secretsEqual } from "../shared/secrets.js";
import { lookupAccessToken } from "../shared/tokens.js";

const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 120;

const failures = new Map();
const usage = new Map();

export function resetAuthState() {
  failures.clear();
  usage.clear();
}

export function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.get?.("X-Forwarded-For") || req.headers?.["x-forwarded-for"];
    if (fwd) return String(fwd).split(",")[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
}

export function failureCount(ip, now = Date.now()) {
  const row = failures.get(ip);
  if (!row || now > row.resetAt) return 0;
  return row.count;
}

export function recordAuthFailure(ip, now = Date.now()) {
  let row = failures.get(ip);
  if (!row || now > row.resetAt) row = { count: 0, resetAt: now + FAIL_WINDOW_MS };
  row.count += 1;
  failures.set(ip, row);
  return row.count;
}

export function authBlocked(ip, now = Date.now()) {
  return failureCount(ip, now) >= FAIL_LIMIT;
}

export function consumeRate(bucket, now = Date.now()) {
  let row = usage.get(bucket);
  if (!row || now > row.resetAt) row = { count: 0, resetAt: now + RATE_WINDOW_MS };
  row.count += 1;
  usage.set(bucket, row);
  return row.count <= RATE_LIMIT;
}

export function extractApiKey(req) {
  const x = req.get?.("X-API-Key") || req.headers?.["x-api-key"];
  if (x) return String(x).replace(/^Bearer\s+/i, "").trim();
  const auth = req.get?.("Authorization") || req.headers?.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return String(auth).replace(/^Bearer\s+/i, "").trim();
  return null;
}

export function resolveCredential(provided, now = Date.now()) {
  if (!provided) return null;
  if (API_KEY && secretsEqual(provided, API_KEY)) return { scope: "write", id: "master" };
  if (READ_KEY && secretsEqual(provided, READ_KEY)) return { scope: "read", id: "read" };
  const token = lookupAccessToken(provided, now);
  if (token) return { scope: token.scope, id: "oauth" };
  return null;
}

export function requireApiKey(req, res, next) {
  const ip = clientIp(req);
  if (failureCount(ip) >= 10) return res.status(429).json({ error: "too_many_attempts" });
  if (!API_KEY) return res.status(500).json({ error: "BRIDGE_API_KEY not configured" });
  const provided = extractApiKey(req);
  const auth = resolveCredential(provided);
  if (!auth) {
    recordAuthFailure(ip);
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!consumeRate(`${auth.id}:${provided}`)) return res.status(429).json({ error: "rate_limited" });
  req.auth = auth;
  next();
}

export function requireWrite(req, res, next) {
  if (req.auth?.scope !== "write") return res.status(403).json({ error: "write_scope_required" });
  next();
}
