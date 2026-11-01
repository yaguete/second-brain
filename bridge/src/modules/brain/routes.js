import { sendError } from "../../shared/utils.js";
import { pool } from "../../shared/db.js";
import { openai, embed } from "../../shared/openai.js";
import { normalizeDocumentDate, normalizeSearchDate } from "../../shared/brain-date.js";
import { brainVectorSearch } from "./service.js";

export function requireBrainDeps(_req, res, next) {
  if (!pool) return res.status(500).json({ error: "DATABASE_URL not configured" });
  if (!openai) return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
  next();
}

export function register(app) {
  app.post("/v1/brain/ingest", requireBrainDeps, async (req, res) => {
    const { chunks } = req.body;
    if (!chunks || !Array.isArray(chunks) || chunks.length === 0) {
      return res.status(400).json({ error: "body must contain 'chunks' array with at least one entry" });
    }

    const replaceSource = req.query.replace_source;

    try {
      if (replaceSource) {
        await pool.query("DELETE FROM brain_chunks WHERE source = $1", [replaceSource]);
      }

      let inserted = 0;
      for (const chunk of chunks) {
        if (!chunk.content) continue;
        const emb = await embed(chunk.content);
        const vecStr = `[${emb.join(",")}]`;
        const tags = Array.isArray(chunk.tags) ? chunk.tags : chunk.tags ? [String(chunk.tags)] : [];
        const documentDate = normalizeDocumentDate(chunk.document_date, { allowFutureDays: 1 });
        const eventDate = normalizeDocumentDate(chunk.event_date, { allowFutureDays: 0 });
        const chunkIndex =
          chunk.chunk_index != null && Number.isFinite(Number(chunk.chunk_index))
            ? Number(chunk.chunk_index)
            : inserted;
        await pool.query(
          `INSERT INTO brain_chunks (source, page_type, title, tags, document_date, event_date, content, chunk_index, embedding)
           VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8, $9::vector)`,
          [
            chunk.source || "unknown",
            chunk.page_type || null,
            chunk.title || null,
            tags,
            documentDate,
            eventDate,
            chunk.content,
            chunkIndex,
            vecStr
          ]
        );
        inserted++;
      }

      res.status(201).json({ inserted, replaced_source: replaceSource || null });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get("/v1/brain/search", requireBrainDeps, async (req, res) => {
    const {
      q,
      limit = "10",
      page_type,
      tag,
      since_date,
      until_date,
      since_event_date,
      until_event_date,
      since_document_date,
      until_document_date
    } = req.query;
    if (!q) return res.status(400).json({ error: "q is required" });

    try {
      const results = await brainVectorSearch(q, {
        limit: Math.max(1, Math.min(50, parseInt(limit, 10))),
        pageType: page_type || undefined,
        tag: tag || undefined,
        sinceDate: since_date || undefined,
        untilDate: until_date || undefined,
        sinceEventDate: since_event_date || undefined,
        untilEventDate: until_event_date || undefined,
        sinceDocumentDate: since_document_date || undefined,
        untilDocumentDate: until_document_date || undefined
      });
      res.json({ query: q, count: results.length, results });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get("/v1/brain/documents", requireBrainDeps, async (req, res) => {
    const { page_type } = req.query;
    try {
      let sql = `SELECT source, page_type, title, document_date, event_date, COUNT(*) AS chunk_count
                 FROM brain_chunks`;
      const params = [];
      if (page_type) {
        sql += ` WHERE page_type = $1`;
        params.push(page_type);
      }
      sql += ` GROUP BY source, page_type, title, document_date, event_date
               ORDER BY event_date DESC NULLS LAST, document_date DESC NULLS LAST, source`;
      const { rows } = await pool.query(sql, params);
      res.json({
        count: rows.length,
        documents: rows.map((r) => ({
          source: r.source,
          page_type: r.page_type,
          title: r.title,
          document_date: r.document_date,
          event_date: r.event_date,
          chunk_count: parseInt(r.chunk_count, 10)
        }))
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get("/v1/brain/documents/:source", requireBrainDeps, async (req, res) => {
    const source = decodeURIComponent(req.params.source);
    try {
      const { rows } = await pool.query(
        `SELECT content, page_type, title, tags, document_date, event_date
         FROM brain_chunks
         WHERE source = $1
         ORDER BY chunk_index NULLS LAST, created_at, id`,
        [source]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Document not found" });
      const fullText = rows.map((r) => r.content).join("\n\n");
      res.json({
        source,
        page_type: rows[0].page_type,
        title: rows[0].title,
        tags: rows[0].tags,
        document_date: rows[0].document_date,
        event_date: rows[0].event_date,
        chunk_count: rows.length,
        content: fullText
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.delete("/v1/brain/documents", requireBrainDeps, async (req, res) => {
    const { source } = req.query;
    if (!source) return res.status(400).json({ error: "source query param is required" });
    try {
      const result = await pool.query("DELETE FROM brain_chunks WHERE source = $1", [source]);
      res.json({ deleted: result.rowCount, source });
    } catch (e) {
      sendError(res, e);
    }
  });
}
