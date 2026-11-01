import { pool } from "../../shared/db.js";
import {
  WITHINGS_CLIENT_ID,
  WITHINGS_CLIENT_SECRET,
  WITHINGS_REDIRECT_URI
} from "../../config.js";

export function requireWithingsEnv(req, res, next) {
  if (!pool) return res.status(500).json({ error: "DATABASE_URL not configured" });
  if (!WITHINGS_CLIENT_ID || !WITHINGS_CLIENT_SECRET || !WITHINGS_REDIRECT_URI) {
    return res.status(500).json({
      error: "Withings OAuth not configured (set WITHINGS_CLIENT_ID, WITHINGS_CLIENT_SECRET, WITHINGS_REDIRECT_URI)"
    });
  }
  next();
}
