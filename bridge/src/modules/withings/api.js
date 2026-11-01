import { PublicError, UpstreamError } from "../../shared/utils.js";
import crypto from "crypto";
import { pool } from "../../shared/db.js";
import {
  WITHINGS_CLIENT_ID,
  WITHINGS_CLIENT_SECRET,
  WITHINGS_REDIRECT_URI,
  WITHINGS_API
} from "../../config.js";

export function withingsFormatScope(scope) {
  return scope
    .split(",")
    .map((s) => `user.${s.trim()}`)
    .join(",");
}

export function withingsSign(action, clientId, clientSecret, baseValue) {
  const data = `${action},${clientId},${baseValue}`;
  return crypto.createHmac("sha256", clientSecret).update(data).digest("hex");
}

export async function withingsFetchNonce() {
  if (!WITHINGS_CLIENT_ID || !WITHINGS_CLIENT_SECRET) {
    throw new PublicError(500, "not_configured", "WITHINGS_CLIENT_ID / WITHINGS_CLIENT_SECRET not configured");
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = withingsSign("getnonce", WITHINGS_CLIENT_ID, WITHINGS_CLIENT_SECRET, String(timestamp));
  const resp = await fetch(`${WITHINGS_API}/signature`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "getnonce",
      client_id: WITHINGS_CLIENT_ID,
      timestamp,
      signature
    })
  });
  const json = await resp.json().catch(() => ({}));
  if (json.status !== 0 || !json.body?.nonce) {
    const msg = json.body?.message || json.error || JSON.stringify(json);
    throw new UpstreamError(`Withings getnonce failed: ${msg}`);
  }
  return json.body.nonce;
}

export function withingsParseApiResponse(json) {
  if (json.status !== 0) {
    const msg = json.body?.message || json.error || JSON.stringify(json.body || json);
    const err = new Error(`Withings API: ${msg}`);
    err.withingsPayload = json;
    throw err;
  }
  return json.body;
}

export async function withingsPostOAuth2(payload) {
  const nonce = await withingsFetchNonce();
  const signature = withingsSign(
    "requesttoken",
    WITHINGS_CLIENT_ID,
    WITHINGS_CLIENT_SECRET,
    nonce
  );
  const body = {
    action: "requesttoken",
    client_id: WITHINGS_CLIENT_ID,
    nonce,
    signature,
    client_secret: WITHINGS_CLIENT_SECRET,
    ...payload
  };
  const resp = await fetch(`${WITHINGS_API}/oauth2`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await resp.json().catch(() => ({}));
  return withingsParseApiResponse(json);
}

export async function withingsExchangeCode(code) {
  return withingsPostOAuth2({
    grant_type: "authorization_code",
    code,
    redirect_uri: WITHINGS_REDIRECT_URI
  });
}

export async function withingsRefreshTokens(refreshToken) {
  return withingsPostOAuth2({
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });
}

export async function withingsSaveTokenBody(body) {
  if (!pool) throw new PublicError(500, "not_configured", "DATABASE_URL not configured");
  const expiresIn = Number(body.expires_in) || 10800;
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  await pool.query(
    `INSERT INTO withings_oauth (id, access_token, refresh_token, expires_at, withings_userid, scope, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, now())
     ON CONFLICT (id) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       expires_at = EXCLUDED.expires_at,
       withings_userid = COALESCE(EXCLUDED.withings_userid, withings_oauth.withings_userid),
       scope = COALESCE(EXCLUDED.scope, withings_oauth.scope),
       updated_at = now()`,
    [
      body.access_token,
      body.refresh_token,
      expiresAt.toISOString(),
      body.userid != null ? String(body.userid) : null,
      body.scope || null
    ]
  );
}

export async function withingsLoadTokens() {
  if (!pool) return null;
  const { rows } = await pool.query(
    "SELECT access_token, refresh_token, expires_at, withings_userid, scope FROM withings_oauth WHERE id = 1"
  );
  return rows[0] || null;
}

/**
 * REST + MCP: same JSON shape so clients (including LLMs) do not treat `expires_at`
 * as "user must re-open auth-url before this instant" when a refresh_token exists.
 */
export function withingsPublicConnectionStatus(row) {
  const hasAccess = Boolean(row?.access_token);
  const hasRefresh = Boolean(row?.refresh_token);
  if (!hasAccess && !hasRefresh) {
    return {
      connected: false,
      message: "No tokens stored. Call GET /v1/withings/auth-url first."
    };
  }
  return {
    connected: true,
    withings_userid: row.withings_userid ?? null,
    scope: row.scope ?? null,
    /** Current OAuth access token expiry (UTC). Short-lived by design. */
    expires_at: row.expires_at ?? null,
    refresh_token_stored: hasRefresh,
    /**
     * `automatic_on_api_use`: bridge refreshes access_token via refresh_token when
     * calling Withings (see withingsGetValidAccessToken). Not a user-visible deadline.
     */
    access_token_rotation: hasRefresh ? "automatic_on_api_use" : "none",
    agent_guidance: hasRefresh
      ? "Do not ask the user to open auth-url only because expires_at is soon or in the past; refresh runs on API use unless Withings returns an auth error."
      : "No refresh token stored: user should complete GET /v1/withings/auth-url before the access token expires."
  };
}

export async function withingsGetValidAccessToken() {
  const row = await withingsLoadTokens();
  if (!row?.access_token) throw new PublicError(400, "not_linked", "Withings not linked. Open GET /v1/withings/auth-url and complete the browser flow.");
  const exp = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (exp > Date.now() + 60_000) return row.access_token;
  if (!row.refresh_token) throw new PublicError(400, "not_linked", "Withings access expired and no refresh token stored.");
  const body = await withingsRefreshTokens(row.refresh_token);
  await withingsSaveTokenBody(body);
  return body.access_token;
}

export async function withingsPost(path, accessToken, params) {
  const resp = await fetch(`${WITHINGS_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(params)
  });
  const json = await resp.json().catch(() => ({}));
  return withingsParseApiResponse(json);
}

export function withingsParseOptionalUnix(input, fallbackUnix) {
  if (input == null || input === "") return fallbackUnix;
  const s = String(input).trim();
  if (/^\d{1,10}$/.test(s)) return parseInt(s, 10);
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new PublicError(400, "invalid_request", `Invalid date or unix timestamp: ${input}`);
  return Math.floor(ms / 1000);
}

function ymdDaysAgo(days) {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

/** Measure v2 getmeas — body measurements (weight, fat, etc.). */
export async function withingsGetBodyMeasurements({
  startdate,
  enddate,
  meastypes,
  category,
  lastupdate
} = {}) {
  const token = await withingsGetValidAccessToken();
  const params = { action: "getmeas" };
  if (lastupdate != null) {
    params.lastupdate = withingsParseOptionalUnix(lastupdate, 0);
  } else {
    const endUnix = withingsParseOptionalUnix(enddate, Math.floor(Date.now() / 1000));
    params.startdate = withingsParseOptionalUnix(startdate, endUnix - 30 * 86400);
    params.enddate = endUnix;
  }
  if (meastypes) params.meastypes = meastypes;
  if (category != null) params.category = category;
  return withingsPost("/measure", token, params);
}

/** Measure v2 getactivity — daily activity summaries. */
export async function withingsGetActivity({
  startdateymd,
  enddateymd,
  lastupdate,
  data_fields
} = {}) {
  const token = await withingsGetValidAccessToken();
  const params = { action: "getactivity" };
  if (lastupdate != null) {
    params.lastupdate = withingsParseOptionalUnix(lastupdate, 0);
  } else {
    params.startdateymd = startdateymd || ymdDaysAgo(30);
    params.enddateymd = enddateymd || todayYmd();
  }
  if (data_fields) params.data_fields = data_fields;
  return withingsPost("/measure", token, params);
}

/** Measure v2 getworkouts — workout sessions. */
export async function withingsGetWorkouts({
  startdateymd,
  enddateymd,
  lastupdate,
  data_fields
} = {}) {
  const token = await withingsGetValidAccessToken();
  const params = { action: "getworkouts" };
  if (lastupdate != null) {
    params.lastupdate = withingsParseOptionalUnix(lastupdate, 0);
  } else {
    params.startdateymd = startdateymd || ymdDaysAgo(30);
    params.enddateymd = enddateymd || todayYmd();
  }
  if (data_fields) params.data_fields = data_fields;
  return withingsPost("/measure", token, params);
}

/** Sleep v2 getsummary — nightly sleep summaries. */
export async function withingsGetSleepSummary({
  startdateymd,
  enddateymd,
  lastupdate,
  data_fields
} = {}) {
  const token = await withingsGetValidAccessToken();
  const params = { action: "getsummary" };
  if (lastupdate != null) {
    params.lastupdate = withingsParseOptionalUnix(lastupdate, 0);
  } else {
    params.startdateymd = startdateymd || ymdDaysAgo(7);
    params.enddateymd = enddateymd || todayYmd();
  }
  if (data_fields) params.data_fields = data_fields;
  return withingsPost("/sleep", token, params);
}
