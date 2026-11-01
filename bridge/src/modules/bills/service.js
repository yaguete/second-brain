import { PublicError } from "../../shared/utils.js";
import { pool } from "../../shared/db.js";
import { llmExtract } from "../../shared/openai.js";
import { BILL_TYPE_PREFIX } from "./constants.js";
import { BILL_EXTRACT_PROMPT, BILL_EXTRACT_PROMPT_VERSION } from "./prompts.js";

/** Default on; set to "0" to always LLM; "strict" = store only, no LLM fallback. */
function storedExtractMode() {
  const v = process.env.BILLS_USE_STORED_EXTRACT;
  if (v === "0") return "off";
  if (v === "strict") return "strict";
  return "on";
}

export async function ensureBillExtractionsTable() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bill_extractions (
      source text PRIMARY KEY,
      prompt_version text NOT NULL,
      payload jsonb NOT NULL,
      extracted_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function upsertBillExtraction(source, promptVersion, payload) {
  if (!pool) throw new PublicError(500, "not_configured", "DATABASE_URL not configured");
  await ensureBillExtractionsTable();
  await pool.query(
    `INSERT INTO bill_extractions (source, prompt_version, payload, extracted_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (source) DO UPDATE SET
       prompt_version = EXCLUDED.prompt_version,
       payload = EXCLUDED.payload,
       extracted_at = now()`,
    [source, promptVersion, JSON.stringify(payload ?? {})]
  );
}

export async function deleteBillExtraction(source) {
  if (!pool) throw new PublicError(500, "not_configured", "DATABASE_URL not configured");
  await ensureBillExtractionsTable();
  await pool.query("DELETE FROM bill_extractions WHERE source = $1", [source]);
}

/**
 * @param {string[]} sources
 * @returns {Promise<Map<string, { payload: object, prompt_version: string }>>}
 */
export async function getBillExtractions(sources) {
  const map = new Map();
  if (!pool || !sources?.length) return map;
  await ensureBillExtractionsTable();
  const { rows } = await pool.query(
    `SELECT source, prompt_version, payload FROM bill_extractions WHERE source = ANY($1::text[])`,
    [sources]
  );
  for (const r of rows) {
    map.set(r.source, { payload: r.payload, prompt_version: r.prompt_version });
  }
  return map;
}

/**
 * Resolve unified bill extraction: prefer stored payload at current prompt version.
 * @param {string} source
 * @param {string} text
 * @param {string} [step]
 */
export async function getOrExtractBill(source, text, step = "bills:extract") {
  const mode = storedExtractMode();

  if (mode === "off") {
    return llmExtract(text, BILL_EXTRACT_PROMPT, step);
  }

  const stored = (await getBillExtractions([source])).get(source);
  if (stored && stored.prompt_version === BILL_EXTRACT_PROMPT_VERSION) {
    return stored.payload;
  }

  if (mode === "strict") {
    throw new PublicError(404, "not_found", `No stored extraction for '${source}'`);
  }

  const payload = await llmExtract(text, BILL_EXTRACT_PROMPT, step);
  await upsertBillExtraction(source, BILL_EXTRACT_PROMPT_VERSION, payload);
  return payload;
}

export async function getBillChunks(source) {
  if (!pool) throw new PublicError(500, "not_configured", "DATABASE_URL not configured");
  const { rows } = await pool.query(
    "SELECT content, document_type, document_date FROM doc_chunks WHERE source = $1 AND document_type LIKE $2 ORDER BY created_at",
    [source, `${BILL_TYPE_PREFIX}%`]
  );
  if (rows.length === 0) throw new PublicError(404, "not_found", `Bill '${source}' not found`);
  return { text: rows.map(r => r.content).join("\n\n"), document_type: rows[0].document_type, document_date: rows[0].document_date };
}

export async function getBillsByFilter({ bill_type, since_date, until_date } = {}) {
  if (!pool) throw new PublicError(500, "not_configured", "DATABASE_URL not configured");
  let sql = `SELECT source, document_type, document_date, STRING_AGG(content, E'\n\n' ORDER BY created_at) AS full_text
             FROM doc_chunks WHERE document_type LIKE $1`;
  const params = [`${BILL_TYPE_PREFIX}%`];
  let idx = 2;
  if (bill_type) { sql += ` AND document_type = $${idx}`; params.push(`${BILL_TYPE_PREFIX}${bill_type}`); idx++; }
  if (since_date) { sql += ` AND document_date >= $${idx}`; params.push(since_date); idx++; }
  if (until_date) { sql += ` AND document_date <= $${idx}`; params.push(until_date); idx++; }
  sql += ` GROUP BY source, document_type, document_date ORDER BY document_date ASC NULLS LAST, source`;
  const { rows } = await pool.query(sql, params);
  return rows;
}
