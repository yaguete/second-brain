import { sendError } from "../../shared/utils.js";
import { pool } from "../../shared/db.js";
import { openai, embed } from "../../shared/openai.js";
import { vectorSearch } from "./service.js";

export function requireJobDeps(_req, res, next) {
  if (!pool) return res.status(500).json({ error: "DATABASE_URL not configured" });
  if (!openai) return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
  next();
}

export function register(app) {
  app.post("/v1/job/ingest", requireJobDeps, async (req, res) => {
    const { chunks } = req.body;
    if (!chunks || !Array.isArray(chunks) || chunks.length === 0) {
      return res.status(400).json({ error: "body must contain 'chunks' array with at least one entry" });
    }

    const replaceSource = req.query.replace_source;

    try {
      if (replaceSource) {
        await pool.query("DELETE FROM doc_chunks WHERE source = $1", [replaceSource]);
      }

      let inserted = 0;
      for (const chunk of chunks) {
        if (!chunk.content) continue;
        const emb = await embed(chunk.content);
        const vecStr = `[${emb.join(",")}]`;
        await pool.query(
          `INSERT INTO doc_chunks (source, document_type, document_date, content, embedding)
           VALUES ($1, $2, $3, $4, $5::vector)`,
          [chunk.source || "unknown", chunk.document_type || null, chunk.document_date || null, chunk.content, vecStr]
        );
        inserted++;
      }

      res.status(201).json({ inserted, replaced_source: replaceSource || null });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get("/v1/job/search", requireJobDeps, async (req, res) => {
    const { q, limit = "10", type, since_date, until_date } = req.query;
    if (!q) return res.status(400).json({ error: "q is required" });

    try {
      const results = await vectorSearch(q, {
        limit: Math.max(1, Math.min(50, parseInt(limit, 10))),
        documentType: type || undefined,
        sinceDate: since_date || undefined,
        untilDate: until_date || undefined
      });
      res.json({ query: q, count: results.length, results });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get("/v1/job/documents", requireJobDeps, async (req, res) => {
    const { type } = req.query;
    try {
      let sql = `SELECT source, document_type, document_date, COUNT(*) AS chunk_count
                 FROM doc_chunks WHERE COALESCE(document_type, '') NOT LIKE 'factura_%'`;
      const params = [];
      if (type) { sql += ` AND document_type = $1`; params.push(type); }
      sql += ` GROUP BY source, document_type, document_date ORDER BY document_date DESC NULLS LAST, source`;
      const { rows } = await pool.query(sql, params);
      res.json({ count: rows.length, documents: rows.map(r => ({ source: r.source, document_type: r.document_type, document_date: r.document_date, chunk_count: parseInt(r.chunk_count) })) });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get("/v1/job/documents/:source", requireJobDeps, async (req, res) => {
    const { source } = req.params;
    try {
      const { rows } = await pool.query(
        "SELECT content, document_type, document_date FROM doc_chunks WHERE source = $1 AND COALESCE(document_type, '') NOT LIKE 'factura_%' ORDER BY created_at",
        [source]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Document not found" });
      const fullText = rows.map(r => r.content).join("\n\n");
      res.json({
        source,
        document_type: rows[0].document_type,
        document_date: rows[0].document_date,
        chunk_count: rows.length,
        content: fullText
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.delete("/v1/job/documents", requireJobDeps, async (req, res) => {
    const { source } = req.query;
    if (!source) return res.status(400).json({ error: "source query param is required" });
    try {
      const result = await pool.query("DELETE FROM doc_chunks WHERE source = $1", [source]);
      res.json({ deleted: result.rowCount, source });
    } catch (e) {
      sendError(res, e);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Bills RAG — REST endpoints
  // ─────────────────────────────────────────────────────────────────────────────
}
