import { sendError } from "../../shared/utils.js";
import { pool } from "../../shared/db.js";
import { embed } from "../../shared/openai.js";
import { requireJobDeps } from "../job/routes.js";
import { BILL_TYPE_PREFIX } from "./constants.js";
import { deleteBillExtraction, upsertBillExtraction } from "./service.js";

export function register(app) {
  app.post("/v1/bills/ingest", requireJobDeps, async (req, res) => {
    const { chunks, extraction } = req.body;
    if (!chunks || !Array.isArray(chunks) || chunks.length === 0) {
      return res.status(400).json({ error: "body must contain 'chunks' array with at least one entry" });
    }

    const replaceSource = req.query.replace_source;

    try {
      if (replaceSource) {
        await pool.query("DELETE FROM doc_chunks WHERE source = $1 AND document_type LIKE $2", [replaceSource, `${BILL_TYPE_PREFIX}%`]);
        await deleteBillExtraction(replaceSource);
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

      let extractionUpserted = false;
      if (extraction && extraction.source && extraction.prompt_version && extraction.payload != null) {
        await upsertBillExtraction(extraction.source, extraction.prompt_version, extraction.payload);
        extractionUpserted = true;
      }

      res.status(201).json({
        inserted,
        replaced_source: replaceSource || null,
        extraction_upserted: extractionUpserted
      });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get("/v1/bills/search", requireJobDeps, async (req, res) => {
    const { q, limit = "10", type, since_date, until_date } = req.query;
    if (!q) return res.status(400).json({ error: "q is required" });

    try {
      const docType = type ? `${BILL_TYPE_PREFIX}${type}` : undefined;
      const queryEmbedding = await embed(q);
      const vecStr = `[${queryEmbedding.join(",")}]`;

      let sql = `SELECT source, document_type, document_date, content,
        1 - (embedding <=> $1::vector) AS score
        FROM doc_chunks WHERE document_type LIKE $2`;
      const params = [vecStr, `${BILL_TYPE_PREFIX}%`];
      let idx = 3;

      if (docType) { sql += ` AND document_type = $${idx}`; params.push(docType); idx++; }
      if (since_date) { sql += ` AND document_date >= $${idx}`; params.push(since_date); idx++; }
      if (until_date) { sql += ` AND document_date <= $${idx}`; params.push(until_date); idx++; }

      sql += ` ORDER BY embedding <=> $1::vector LIMIT $${idx}`;
      params.push(Math.max(1, Math.min(50, parseInt(limit, 10))));

      const { rows } = await pool.query(sql, params);
      const results = rows.map(r => ({ source: r.source, document_type: r.document_type, document_date: r.document_date, content: r.content, score: Math.round(r.score * 1000) / 1000 }));
      res.json({ query: q, count: results.length, results });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get("/v1/bills/documents", requireJobDeps, async (req, res) => {
    const { type } = req.query;
    try {
      let sql = `SELECT source, document_type, document_date, COUNT(*) AS chunk_count
                 FROM doc_chunks WHERE document_type LIKE $1`;
      const params = [`${BILL_TYPE_PREFIX}%`];
      if (type) { sql += ` AND document_type = $2`; params.push(`${BILL_TYPE_PREFIX}${type}`); }
      sql += ` GROUP BY source, document_type, document_date ORDER BY document_date DESC NULLS LAST, source`;
      const { rows } = await pool.query(sql, params);
      res.json({ count: rows.length, documents: rows.map(r => ({ source: r.source, document_type: r.document_type, document_date: r.document_date, chunk_count: parseInt(r.chunk_count) })) });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get("/v1/bills/documents/:source", requireJobDeps, async (req, res) => {
    const { source } = req.params;
    try {
      const { rows } = await pool.query(
        "SELECT content, document_type, document_date FROM doc_chunks WHERE source = $1 AND document_type LIKE $2 ORDER BY created_at",
        [source, `${BILL_TYPE_PREFIX}%`]
      );
      if (rows.length === 0) return res.status(404).json({ error: "Bill not found" });
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

  app.delete("/v1/bills/documents", requireJobDeps, async (req, res) => {
    const { source } = req.query;
    if (!source) return res.status(400).json({ error: "source query param is required" });
    try {
      const result = await pool.query("DELETE FROM doc_chunks WHERE source = $1 AND document_type LIKE $2", [source, `${BILL_TYPE_PREFIX}%`]);
      try {
        await deleteBillExtraction(source);
      } catch {
        /* table may not exist yet */
      }
      res.json({ deleted: result.rowCount, source });
    } catch (e) {
      sendError(res, e);
    }
  });
}
