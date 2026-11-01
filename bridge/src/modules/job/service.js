import { PublicError } from "../../shared/utils.js";
import { pool } from "../../shared/db.js";
import { embed } from "../../shared/openai.js";

export async function vectorSearch(queryText, { limit = 10, documentType, sinceDate, untilDate } = {}) {
  if (!pool) throw new PublicError(500, "not_configured", "DATABASE_URL not configured");
  const queryEmbedding = await embed(queryText);
  const vecStr = `[${queryEmbedding.join(",")}]`;

  let sql = `SELECT source, document_type, document_date, content,
    1 - (embedding <=> $1::vector) AS score
    FROM doc_chunks WHERE COALESCE(document_type, '') NOT LIKE 'factura_%'`;
  const params = [vecStr];
  let idx = 2;

  if (documentType) { sql += ` AND document_type = $${idx}`; params.push(documentType); idx++; }
  if (sinceDate) { sql += ` AND document_date >= $${idx}`; params.push(sinceDate); idx++; }
  if (untilDate) { sql += ` AND document_date <= $${idx}`; params.push(untilDate); idx++; }

  sql += ` ORDER BY embedding <=> $1::vector LIMIT $${idx}`;
  params.push(limit);

  const { rows } = await pool.query(sql, params);
  return rows.map(r => ({ source: r.source, document_type: r.document_type, document_date: r.document_date, content: r.content, score: Math.round(r.score * 1000) / 1000 }));
}
