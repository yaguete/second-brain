import { PublicError, mcpFail } from "../../shared/utils.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pool } from "../../shared/db.js";
import {
  WITHINGS_CLIENT_ID,
  WITHINGS_CLIENT_SECRET,
  WITHINGS_REDIRECT_URI
} from "../../config.js";
import {
  withingsLoadTokens,
  withingsPublicConnectionStatus,
  withingsGetValidAccessToken,
  withingsPost,
  withingsParseOptionalUnix,
  withingsGetBodyMeasurements,
  withingsGetActivity,
  withingsGetWorkouts,
  withingsGetSleepSummary
} from "./api.js";

export function createWithingsMcpServer() {
  const mcp = new McpServer({ name: "withings", version: "1.0.0" });

  const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
  const fail = mcpFail;

  mcp.registerTool("get_withings_connection_status", {
    title: "Withings connection status",
    description:
      "OAuth linkage for Withings. Field expires_at is the short-lived access token only. If refresh_token_stored is true and access_token_rotation is automatic_on_api_use, the bridge refreshes tokens on tool calls—do not urge the user to re-authorize based on expires_at alone. If connected is false, open GET /v1/withings/auth-url once.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, async () => {
    try {
      if (!pool) throw new PublicError(500, "not_configured", "DATABASE_URL not configured");
      if (!WITHINGS_CLIENT_ID || !WITHINGS_CLIENT_SECRET || !WITHINGS_REDIRECT_URI) {
        throw new PublicError(500, "not_configured", "Withings OAuth env vars not set (WITHINGS_CLIENT_ID, WITHINGS_CLIENT_SECRET, WITHINGS_REDIRECT_URI)");
      }
      const row = await withingsLoadTokens();
      return ok(withingsPublicConnectionStatus(row));
    } catch (e) { return fail(e); }
  });

  // ── Measure: getmeas (body measurements) ──────────────────────────────────

  mcp.registerTool("get_body_measurements", {
    title: "Body measurements",
    description: "Fetch body measurements from Withings (weight, fat mass, muscle mass, etc.) via Measure v2 getmeas. Default range: last 30 days. Measurement type IDs: 1=weight(kg), 5=fat-free mass, 6=fat ratio(%), 8=fat mass(kg), 11=heart pulse(bpm), 12=temperature, 54=SpO2(%), 71=body temp, 76=muscle mass(kg), 77=hydration(kg), 88=bone mass(kg), 91=pulse wave velocity(m/s).",
    inputSchema: z.object({
      startdate: z.union([z.string(), z.number()]).optional().describe("Start: unix seconds or ISO date string (default: 30 days ago)"),
      enddate: z.union([z.string(), z.number()]).optional().describe("End: unix seconds or ISO date string (default: now)"),
      meastypes: z.string().optional().describe("Comma-separated type IDs, e.g. '1,6,8' for weight + fat ratio + fat mass"),
      category: z.number().optional().describe("1=real measures (default), 2=user objectives"),
      lastupdate: z.union([z.string(), z.number()]).optional().describe("Only data updated since this unix/ISO timestamp (alternative to date range)")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ startdate, enddate, meastypes, category, lastupdate }) => {
    try {
      return ok(await withingsGetBodyMeasurements({ startdate, enddate, meastypes, category, lastupdate }));
    } catch (e) { return fail(e); }
  });

  // ── Measure: getactivity (daily activity summaries) ──────────────────────

  mcp.registerTool("get_activity", {
    title: "Daily activity",
    description: "Fetch daily activity summaries (steps, distance, calories, elevation, etc.) from Withings Measure v2 getactivity. Default range: last 30 days. Dates use YYYY-MM-DD format.",
    inputSchema: z.object({
      startdateymd: z.string().optional().describe("Start date YYYY-MM-DD (default: 30 days ago)"),
      enddateymd: z.string().optional().describe("End date YYYY-MM-DD (default: today)"),
      lastupdate: z.union([z.string(), z.number()]).optional().describe("Only data updated since this unix/ISO timestamp"),
      data_fields: z.string().optional().describe("Comma-separated fields: steps,distance,elevation,soft,moderate,intense,active,calories,totalcalories,hr_average,hr_min,hr_max,hr_zone_0,hr_zone_1,hr_zone_2,hr_zone_3")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ startdateymd, enddateymd, lastupdate, data_fields }) => {
    try {
      return ok(await withingsGetActivity({ startdateymd, enddateymd, lastupdate, data_fields }));
    } catch (e) { return fail(e); }
  });

  // ── Measure: getintradayactivity ─────────────────────────────────────────

  mcp.registerTool("get_intraday_activity", {
    title: "Intraday activity",
    description: "Fetch intraday (minute-level) activity data from Withings. Max range ~24 h. Returns steps, calories, elevation, etc. in short time intervals.",
    inputSchema: z.object({
      startdate: z.union([z.string(), z.number()]).optional().describe("Start: unix seconds or ISO (default: 24 h ago)"),
      enddate: z.union([z.string(), z.number()]).optional().describe("End: unix seconds or ISO (default: now)"),
      data_fields: z.string().optional().describe("Comma-separated: steps,elevation,calories,distance,stroke,pool_lap,duration,heart_rate,spo2_auto")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ startdate, enddate, data_fields }) => {
    try {
      const token = await withingsGetValidAccessToken();
      const endUnix = withingsParseOptionalUnix(enddate, Math.floor(Date.now() / 1000));
      const startUnix = withingsParseOptionalUnix(startdate, endUnix - 86400);
      const params = { action: "getintradayactivity", startdate: startUnix, enddate: endUnix };
      if (data_fields) params.data_fields = data_fields;
      return ok(await withingsPost("/measure", token, params));
    } catch (e) { return fail(e); }
  });

  // ── Measure: getworkouts ─────────────────────────────────────────────────

  mcp.registerTool("get_workouts", {
    title: "Workouts",
    description: "Fetch workout sessions from Withings (running, cycling, swimming, etc.). Default range: last 30 days.",
    inputSchema: z.object({
      startdateymd: z.string().optional().describe("Start date YYYY-MM-DD"),
      enddateymd: z.string().optional().describe("End date YYYY-MM-DD"),
      lastupdate: z.union([z.string(), z.number()]).optional().describe("Only data updated since this unix/ISO timestamp"),
      data_fields: z.string().optional().describe("Comma-separated: steps,distance,elevation,calories,intensity,hr_average,hr_min,hr_max,pause_duration,algo_pause_duration,spo2_average,manual_distance,manual_calories")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ startdateymd, enddateymd, lastupdate, data_fields }) => {
    try {
      return ok(await withingsGetWorkouts({ startdateymd, enddateymd, lastupdate, data_fields }));
    } catch (e) { return fail(e); }
  });

  // ── Sleep v2: getsummary ─────────────────────────────────────────────────

  mcp.registerTool("get_sleep_summary", {
    title: "Sleep summary",
    description: "Fetch nightly sleep summaries from Withings (score, duration, deep/light/REM, breathing disturbances, HR, snoring, etc.). Default range: last 7 days.",
    inputSchema: z.object({
      startdateymd: z.string().optional().describe("Start date YYYY-MM-DD (default: 7 days ago)"),
      enddateymd: z.string().optional().describe("End date YYYY-MM-DD (default: today)"),
      lastupdate: z.union([z.string(), z.number()]).optional().describe("Only data updated since this unix/ISO timestamp"),
      data_fields: z.string().optional().describe("Comma-separated: breathing_disturbances_intensity,deepsleepduration,durationtosleep,durationtowakeup,hr_average,hr_max,hr_min,lightsleepduration,nb_rem_episodes,night_events,out_of_bed_count,remsleepduration,rr_average,rr_max,rr_min,sleep_efficiency,sleep_latency,sleep_score,snoring,snoringepisodecount,total_sleep_time,total_timeinbed,wakeupcount,wakeupduration")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ startdateymd, enddateymd, lastupdate, data_fields }) => {
    try {
      return ok(await withingsGetSleepSummary({ startdateymd, enddateymd, lastupdate, data_fields }));
    } catch (e) { return fail(e); }
  });

  // ── Sleep v2: get (detailed sleep data) ──────────────────────────────────

  mcp.registerTool("get_sleep", {
    title: "Sleep detail",
    description: "Fetch detailed sleep data from Withings (minute-level sleep state, HR series, breathing, snoring). Default range: last 24 hours.",
    inputSchema: z.object({
      startdate: z.union([z.string(), z.number()]).optional().describe("Start: unix seconds or ISO (default: 24 h ago)"),
      enddate: z.union([z.string(), z.number()]).optional().describe("End: unix seconds or ISO (default: now)"),
      data_fields: z.string().optional().describe("Comma-separated: hr,rr,snoring,sdnn_1,rmssd")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ startdate, enddate, data_fields }) => {
    try {
      const token = await withingsGetValidAccessToken();
      const endUnix = withingsParseOptionalUnix(enddate, Math.floor(Date.now() / 1000));
      const startUnix = withingsParseOptionalUnix(startdate, endUnix - 86400);
      const params = { action: "get", startdate: startUnix, enddate: endUnix };
      if (data_fields) params.data_fields = data_fields;
      return ok(await withingsPost("/sleep", token, params));
    } catch (e) { return fail(e); }
  });

  // ── Heart v2: list (ECG / heart recordings) ─────────────────────────────

  mcp.registerTool("get_heart_list", {
    title: "Heart recordings",
    description: "List heart/ECG recordings from Withings Heart v2. Default range: last 30 days.",
    inputSchema: z.object({
      startdate: z.union([z.string(), z.number()]).optional().describe("Start: unix seconds or ISO (default: 30 days ago)"),
      enddate: z.union([z.string(), z.number()]).optional().describe("End: unix seconds or ISO (default: now)"),
      offset: z.number().optional().describe("Pagination offset")
    }),
    annotations: { readOnlyHint: true }
  }, async ({ startdate, enddate, offset }) => {
    try {
      const token = await withingsGetValidAccessToken();
      const endUnix = withingsParseOptionalUnix(enddate, Math.floor(Date.now() / 1000));
      const startUnix = withingsParseOptionalUnix(startdate, endUnix - 30 * 86400);
      const params = { action: "list", startdate: startUnix, enddate: endUnix };
      if (offset != null) params.offset = offset;
      return ok(await withingsPost("/heart", token, params));
    } catch (e) { return fail(e); }
  });

  // ── User v2: getdevice ───────────────────────────────────────────────────

  mcp.registerTool("get_devices", {
    title: "Withings devices",
    description:
      "List Withings devices (scales, watches, etc.). Requires OAuth scopes that allow user device APIs; if Withings returns scope/permission errors, expand WITHINGS_SCOPE on the server and run GET /v1/withings/auth-url again.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, async () => {
    try {
      const token = await withingsGetValidAccessToken();
      return ok(await withingsPost("/user", token, { action: "getdevice" }));
    } catch (e) { return fail(e); }
  });

  // ── User v2: getgoals ────────────────────────────────────────────────────

  mcp.registerTool("get_goals", {
    title: "User goals",
    description: "Fetch the user's Withings goals (step target, sleep target, weight target).",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, async () => {
    try {
      const token = await withingsGetValidAccessToken();
      return ok(await withingsPost("/user", token, { action: "getgoals" }));
    } catch (e) { return fail(e); }
  });

  return mcp;
}
