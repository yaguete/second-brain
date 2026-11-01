import { PublicError } from "./utils.js";
import OpenAI from "openai";
import { EMBEDDING_DIM } from "./db.js";
import { recordUsage } from "./llm-usage.js";

export const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/**
 * Embeddings for RAG (`embed()`). Default `text-embedding-3-large` @ `EMBEDDING_DIM` (1536) to match `vector(1536)`
 * and reduce vendor churn vs `text-embedding-3-small` (OpenAI sunset Oct 2026 per deprecation notices).
 * Override with `OPENAI_EMBEDDING_MODEL` / `OPENAI_EMBEDDING_DIMENSIONS` if needed.
 */
export const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-large";

const _dimsRaw = process.env.OPENAI_EMBEDDING_DIMENSIONS;
export const EMBEDDING_DIMENSIONS_USED = (() => {
  if (_dimsRaw == null || _dimsRaw === "") return EMBEDDING_DIM;
  const n = parseInt(_dimsRaw, 10);
  return Number.isFinite(n) && n > 0 ? n : EMBEDDING_DIM;
})();

/** Chat completions: bills MCP JSON extraction, etc. */
export const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";

export async function embed(text) {
  if (!openai) throw new PublicError(500, "not_configured", "OPENAI_API_KEY not configured");
  const req = {
    model: EMBEDDING_MODEL,
    input: text,
    dimensions: EMBEDDING_DIMENSIONS_USED
  };
  const res = await openai.embeddings.create(req);
  return res.data[0].embedding;
}

export async function llmExtract(text, systemPrompt, step = "bills:unknown") {
  if (!openai) throw new PublicError(500, "not_configured", "OPENAI_API_KEY not configured");
  const resp = await openai.chat.completions.create({
    model: CHAT_MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: text.slice(0, 120000) }
    ],
    temperature: 0
  });
  recordUsage({
    step,
    model: CHAT_MODEL,
    usage: resp.usage,
    message: resp.choices?.[0]?.message,
    extra: { system_chars: systemPrompt.length, user_chars: Math.min(text.length, 120000) }
  });
  return JSON.parse(resp.choices?.[0]?.message?.content || "{}");
}
