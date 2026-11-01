import { pool } from "../../shared/db.js";

export async function initBillsSchema() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bill_extractions (
        source text PRIMARY KEY,
        prompt_version text NOT NULL,
        payload jsonb NOT NULL,
        extracted_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  } catch (e) {
    console.error("Bills schema init error (non-fatal):", e.message);
  }
}
