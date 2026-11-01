import { pool, EMBEDDING_DIM } from "../../shared/db.js";

export async function initJobSchema() {
  if (!pool) return;
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS doc_chunks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source TEXT NOT NULL,
        document_type TEXT,
        document_date TEXT,
        content TEXT NOT NULL,
        embedding vector(${EMBEDDING_DIM}),
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS doc_chunks_embedding_idx
      ON doc_chunks USING hnsw (embedding vector_cosine_ops)
    `);
  } catch (e) {
    console.error("Job schema init error (non-fatal):", e.message);
  }
}
