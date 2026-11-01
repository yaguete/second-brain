import { pool } from "../../shared/db.js";

export async function initWithingsSchema() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS withings_oauth (
        id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        access_token TEXT,
        refresh_token TEXT,
        expires_at TIMESTAMPTZ,
        withings_userid TEXT,
        scope TEXT,
        updated_at TIMESTAMPTZ DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS withings_oauth_states (
        state TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `);
  } catch (e) {
    console.error("Withings schema init error (non-fatal):", e.message);
  }
}
