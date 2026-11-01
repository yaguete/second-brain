#!/usr/bin/env node

/**
 * Re-embed every row in doc_chunks using the current OpenAI embedding settings
 * (see src/shared/openai.js: OPENAI_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS_USED).
 *
 * Run AFTER deploying code that switches embedding model, or run with explicit
 * OPENAI_* env to align all stored vectors before serving traffic with the new model.
 *
 * Usage:
 *   npm run reembed:doc-chunks
 *   npm run reembed:doc-chunks -- --dry-run
 *
 * Requires: DATABASE_URL, OPENAI_API_KEY (e.g. node --env-file=.env)
 */

import { pool, EMBEDDING_DIM } from "../bridge/src/shared/db.js";
import { embed, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS_USED } from "../bridge/src/shared/openai.js";

const DRY = process.argv.includes("--dry-run");
const BATCH = Math.max(1, parseInt(process.env.REEMBED_BATCH_SIZE || "25", 10));
const SLEEP_MS = Math.max(0, parseInt(process.env.REEMBED_SLEEP_MS || "150", 10));

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  if (!pool) {
    console.error("Error: DATABASE_URL not configured");
    process.exit(1);
  }

  console.log(`Embedding model: ${EMBEDDING_MODEL}`);
  console.log(`Dimensions: ${EMBEDDING_DIMENSIONS_USED} (DB vector dim ${EMBEDDING_DIM})`);
  if (DRY) console.log("DRY RUN — no updates\n");

  const { rows: [{ count }] } = await pool.query(
    "SELECT COUNT(*)::int AS count FROM doc_chunks WHERE content IS NOT NULL AND trim(content) <> ''"
  );
  const { rows: [{ count: skipCount }] } = await pool.query(
    "SELECT COUNT(*)::int AS count FROM doc_chunks WHERE content IS NULL OR trim(content) = ''"
  );
  console.log(`Rows to process: ${count} (skipping empty content: ${skipCount})\n`);

  let offset = 0;
  let done = 0;
  let errors = 0;

  while (offset < count) {
    const { rows } = await pool.query(
      `SELECT id, content
       FROM doc_chunks
       WHERE content IS NOT NULL AND trim(content) <> ''
       ORDER BY created_at, id
       LIMIT $1 OFFSET $2`,
      [BATCH, offset]
    );

    if (rows.length === 0) break;

    for (const { id, content: text } of rows) {
      if (!text || !text.trim()) continue;
      const preview = text.slice(0, 80).replace(/\s+/g, " ");

      try {
        if (DRY) {
          console.log(`[dry-run] ${id} …${preview}`);
          done++;
          continue;
        }

        const vector = await embed(text);
        if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIM) {
          throw new Error(`bad embedding length ${vector?.length}, expected ${EMBEDDING_DIM}`);
        }
        const vecStr = `[${vector.join(",")}]`;
        await pool.query("UPDATE doc_chunks SET embedding = $1::vector WHERE id = $2", [vecStr, id]);
        done++;
        if (done % 10 === 0 || done === count) {
          process.stdout.write(`\rUpdated ${done}/${count}`);
        }
      } catch (e) {
        errors++;
        console.error(`\nError id=${id}: ${e.message}`);
      }
    }

    offset += rows.length;
    if (SLEEP_MS && !DRY) await sleep(SLEEP_MS);
  }

  console.log(DRY ? `\nDry run finished (${done} rows).` : `\nDone. Updated ${done}, errors ${errors}.`);
  await pool.end();
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
