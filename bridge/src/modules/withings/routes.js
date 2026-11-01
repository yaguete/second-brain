import crypto from "crypto";
import { pool } from "../../shared/db.js";
import { WITHINGS_CLIENT_ID, WITHINGS_CLIENT_SECRET, WITHINGS_REDIRECT_URI, WITHINGS_SCOPE_RAW, WITHINGS_AUTH_BASE } from "../../config.js";
import { escapeHtml } from "../../shared/utils.js";
import {
  withingsFormatScope,
  withingsExchangeCode,
  withingsSaveTokenBody,
  withingsLoadTokens,
  withingsPublicConnectionStatus
} from "./api.js";
import { requireWithingsEnv } from "./middleware.js";

export function registerCallback(app) {
  app.get("/withings/callback", async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).type("html").send("<p>Missing <code>code</code> or <code>state</code>.</p>");
    }
    if (!pool || !WITHINGS_CLIENT_ID || !WITHINGS_CLIENT_SECRET || !WITHINGS_REDIRECT_URI) {
      return res.status(500).type("html").send("<p>Withings OAuth is not configured on this server.</p>");
    }
    try {
      const { rows } = await pool.query(
        `SELECT state FROM withings_oauth_states
         WHERE state = $1 AND created_at >= now() - interval '15 minutes'`,
        [state]
      );
      if (rows.length === 0) {
        return res.status(400).type("html").send("<p>Invalid or expired <code>state</code>. Request a new URL from <code>GET /v1/withings/auth-url</code>.</p>");
      }
      await pool.query("DELETE FROM withings_oauth_states WHERE state = $1", [state]);
      const body = await withingsExchangeCode(String(code));
      await withingsSaveTokenBody(body);
      return res.type("html").send(
        "<p>Withings connected successfully. You can close this tab and use the MCP tools.</p>"
      );
    } catch (e) {
      console.error(e);
      return res.status(500).type("html").send("<p>Withings could not be connected. Check the server log.</p>");
    }
  });

  }

  export function registerV1Routes(app) {
  app.get("/v1/withings/auth-url", requireWithingsEnv, async (_req, res) => {
    try {
      await pool.query("DELETE FROM withings_oauth_states WHERE created_at < now() - interval '15 minutes'");
      const state = crypto.randomBytes(24).toString("hex");
      await pool.query("INSERT INTO withings_oauth_states (state) VALUES ($1)", [state]);
      const scope = encodeURIComponent(withingsFormatScope(WITHINGS_SCOPE_RAW));
      const redirect = encodeURIComponent(WITHINGS_REDIRECT_URI);
      const url =
        `${WITHINGS_AUTH_BASE}?response_type=code&client_id=${encodeURIComponent(WITHINGS_CLIENT_ID)}` +
        `&state=${encodeURIComponent(state)}&scope=${scope}&redirect_uri=${redirect}`;
      res.json({ authorization_url: url, state, note: "Open authorization_url in a browser once; callback stores tokens." });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get("/v1/withings/status", requireWithingsEnv, async (_req, res) => {
    try {
      const row = await withingsLoadTokens();
      res.json(withingsPublicConnectionStatus(row));
    } catch (e) {
      sendError(res, e);
    }
  });

}
