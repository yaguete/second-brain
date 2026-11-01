import { PublicError } from "../../shared/utils.js";
import { pool } from "../../shared/db.js";
import { embed } from "../../shared/openai.js";
import { normalizeSearchDate } from "../../shared/brain-date.js";

/**
 * @param {string} queryText
 * @param {{
 *   limit?: number,
 *   pageType?: string,
 *   tag?: string,
 *   sinceDate?: string,
 *   untilDate?: string,
 *   sinceEventDate?: string,
 *   untilEventDate?: string,
 *   sinceDocumentDate?: string,
 *   untilDocumentDate?: string
 * }} [opts]
 */
export async function brainVectorSearch(
  queryText,
  {
    limit = 10,
    pageType,
    tag,
    sinceDate,
    untilDate,
    sinceEventDate,
    untilEventDate,
    sinceDocumentDate,
    untilDocumentDate
  } = {}
) {
  if (!pool) throw new PublicError(500, "not_configured", "DATABASE_URL not configured");
  const queryEmbedding = await embed(queryText);
  const vecStr = `[${queryEmbedding.join(",")}]`;

  let sql = `SELECT source, page_type, title, tags, document_date, event_date, content,
    1 - (embedding <=> $1::vector) AS score
    FROM brain_chunks WHERE 1=1`;
  const params = [vecStr];
  let idx = 2;

  if (pageType) {
    sql += ` AND page_type = $${idx}`;
    params.push(pageType);
    idx++;
  }
  if (tag) {
    sql += ` AND $${idx} = ANY(tags)`;
    params.push(tag);
    idx++;
  }

  const addDateFilter = (column, rawSince, rawUntil, useCoalesce = false) => {
    const col = useCoalesce ? `COALESCE(event_date, document_date)` : column;
    const since = normalizeSearchDate(rawSince, { boundary: "start" });
    const until = normalizeSearchDate(rawUntil, { boundary: "end" });
    if (since) {
      sql += ` AND ${col} >= $${idx}`;
      params.push(since);
      idx++;
    }
    if (until) {
      sql += ` AND ${col} <= $${idx}`;
      params.push(until);
      idx++;
    }
  };

  addDateFilter(null, sinceDate, untilDate, true);
  addDateFilter("event_date", sinceEventDate, untilEventDate, false);
  addDateFilter("document_date", sinceDocumentDate, untilDocumentDate, false);

  sql += ` ORDER BY embedding <=> $1::vector LIMIT $${idx}`;
  params.push(limit);

  const { rows } = await pool.query(sql, params);
  return rows.map((r) => ({
    source: r.source,
    page_type: r.page_type,
    title: r.title,
    tags: r.tags,
    document_date: r.document_date,
    event_date: r.event_date,
    content: r.content,
    score: Math.round(r.score * 1000) / 1000
  }));
}
