import { pool, EMBEDDING_DIM } from "../../shared/db.js";

export async function initBrainSchema() {
  if (!pool) return;
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS brain_chunks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source TEXT NOT NULL,
        page_type TEXT,
        title TEXT,
        tags TEXT[],
        document_date TEXT,
        event_date TEXT,
        content TEXT NOT NULL,
        chunk_index INTEGER,
        embedding vector(${EMBEDDING_DIM}),
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `);
    await pool.query(`
      ALTER TABLE brain_chunks
      ADD COLUMN IF NOT EXISTS chunk_index INTEGER
    `);
    await pool.query(`
      ALTER TABLE brain_chunks
      ADD COLUMN IF NOT EXISTS event_date TEXT
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS brain_chunks_embedding_idx
      ON brain_chunks USING hnsw (embedding vector_cosine_ops)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS brain_chunks_source_idx
      ON brain_chunks (source)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS brain_chunks_event_date_idx
      ON brain_chunks (event_date)
    `);
  } catch (e) {
    console.error("Brain schema init error (non-fatal):", e.message);
  }
}
