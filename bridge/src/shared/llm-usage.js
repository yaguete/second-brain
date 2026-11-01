import fs from "fs";
import path from "path";

/**
 * Tarifas $/1M tokens. DeepSeek verificadas 2026-10-20 (off-peak); OpenAI 2026-08-06:
 *  https://api-docs.deepseek.com/quick_start/pricing/
 *  https://developers.openai.com/api/docs/pricing
 * OJO: DeepSeek cobra 2x en horario pico (ver deepseekPeakWarning).
 * `deepseek-v4-flash` es alias retirado: lo sirve V4.1-Flash y se cobra como `deepseek-flash`.
 */
export const RATES = {
  "deepseek-flash": { miss: 0.15, hit: 0.003, out: 0.6, write: null },
  "deepseek-v4-pro": { miss: 0.66, hit: 0.022, out: 1.98, write: null },
  "deepseek-v4-flash": { miss: 0.15, hit: 0.003, out: 0.6, write: null },
  "deepseek-chat": { miss: 0.14, hit: 0.014, out: 0.28, write: null },
  "gpt-5.6-luna": { miss: 0.2, hit: 0.02, out: 1.2, write: 0.25 },
  "gpt-5.6-terra": { miss: 2.0, hit: 0.2, out: 12.0, write: 2.5 },
  "gpt-5.6-sol": { miss: 5.0, hit: 0.5, out: 15.0, write: 6.25 },
  "gpt-4o-mini": { miss: 0.15, hit: 0.075, out: 0.6, write: null }
};

/**
 * @param {object | null | undefined} usage
 * @param {{ reasoning_content?: string } | null | undefined} [message]
 */
export function normalizeUsage(usage, message) {
  if (!usage) return null;
  const prompt = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const completion = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const details = usage.prompt_tokens_details ?? usage.input_tokens_details ?? {};
  const cached = usage.prompt_cache_hit_tokens ?? details.cached_tokens ?? 0;
  const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, prompt - cached);
  const cacheWrite = details.cache_write_tokens ?? 0;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? null;
  const reasoningChars = message?.reasoning_content?.length ?? null;
  return {
    prompt,
    completion,
    cached,
    miss,
    cacheWrite,
    reasoning,
    reasoningChars,
    hitRate: prompt ? cached / prompt : 0
  };
}

/**
 * @param {ReturnType<typeof normalizeUsage>} u
 * @param {string} model
 */
export function costUsd(u, model) {
  const r = RATES[model];
  if (!r || !u) return null;
  const written = r.write != null ? u.cacheWrite : 0;
  const plain = Math.max(0, u.miss - written);
  return (
    (plain * r.miss +
      u.cached * r.hit +
      written * (r.write ?? r.miss) +
      u.completion * r.out) /
    1_000_000
  );
}

const LEDGER =
  process.env.LLM_USAGE_LOG || path.join(process.cwd(), ".llm-usage.jsonl");

export const RUN_ID = `${new Date().toISOString()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Registra una llamada. `step` es la clave: analysis|source|update|create|log|monthly|websearch|bills:*|ocr
 * @returns {object | null}
 */
export function recordUsage({ step, model, usage, message, extra = {} }) {
  const u = normalizeUsage(usage, message);
  if (!u) return null;
  const cost = costUsd(u, model);
  const beijingHour = (new Date().getUTCHours() + 8) % 24;
  const row = {
    ts: new Date().toISOString(),
    run_id: RUN_ID,
    step,
    model,
    beijing_hour: beijingHour,
    ...u,
    cost_usd: cost,
    ...extra
  };
  try {
    fs.appendFileSync(LEDGER, `${JSON.stringify(row)}\n`);
  } catch {
    /* best-effort */
  }
  console.log(
    `  [usage ${step}] prompt=${u.prompt} cached=${u.cached} miss=${u.miss}` +
      (u.cacheWrite ? ` write=${u.cacheWrite}` : "") +
      ` hit=${(u.hitRate * 100).toFixed(1)}% out=${u.completion}` +
      (u.reasoning != null ? ` reasoning=${u.reasoning}` : "") +
      (u.reasoningChars != null ? ` reasoning_chars=${u.reasoningChars}` : "") +
      (cost != null ? ` ~$${cost.toFixed(5)}` : "")
  );
  return row;
}

export function getLedgerPath() {
  return LEDGER;
}
