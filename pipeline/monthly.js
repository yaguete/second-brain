#!/usr/bin/env node

/**
 * Genera "la historia del mes" del mes anterior (o --month=YYYY-MM) y la escribe en el inbox del vault.
 *
 * Uso:
 *   npm run monthly
 *   npm run monthly -- --dry-run
 *   npm run monthly -- --month=2026-06
 *
 * Env:
 *   OBSIDIAN_VAULT_PATH — raíz del vault Obsidian
 *   INBOX_DIR — carpeta inbox relativa al vault (default: 📥 Inbox)
 *   BRIDGE_URL, BRIDGE_API_KEY — API del bridge (default localhost:3000)
 *   MONTHLY_SYNTHESIS_MODEL — default gpt-5.6-luna
 *   MONTHLY_SYNTHESIS_BASE_URL — opcional
 *   MONTHLY_SYNTHESIS_API_KEY — opcional
 *   MONTHLY_BUDGET_ID, MONTHLY_TR_ACCOUNT_ID — overrides YNAB
 *   MONTHLY_MAX_CONTEXT_CHARS — presupuesto total de contexto (default 900000)
 *   MONTHLY_MAX_DOC_CHARS — máximo por documento vault (default 60000)
 *   MONTHLY_PORTFOLIO_DOC — ruta relativa al portfolio (default 🚀 Personal/💶 Wealth/portfolio.md)
 *   MONTHLY_ANCHOR_DOCS — rutas relativas separadas por comas (default objetivos/tesis/bitácora de Wealth)
 *   MONTHLY_MAX_TOUCHED_DOCS — máximo de docs tocados en el mes incluidos (default 50)
 *   MONTHLY_MAX_TOUCHED_DOCS_CHARS — presupuesto de chars para docs tocados (default 400000)
 *   MONTHLY_WEBSEARCH_MODEL — modelo OpenAI para búsqueda web (default gpt-5.6-luna)
 *   MONTHLY_WEBSEARCH_MAX_OUTPUT_TOKENS — tope de salida de la búsqueda web (default 20000)
 *   NEWSAPI_KEY — API key de NewsAPI.ai (Event Registry) para contrastar el contexto de mercado
 *   NEWSAPI_BASE_URL — default https://eventregistry.org/api/v1 (REST; el MCP alojado solo acepta OAuth)
 *   MONTHLY_NEWSAPI_CONCEPTS — JSON {"TICKER": "http://en.wikipedia.org/wiki/..." | [uri, uri]} para tickers nuevos
 *   MONTHLY_NEWSAPI_LANG — idioma de los eventos (default eng; vacío = todos)
 *   MONTHLY_NEWSAPI_EVENTS_PER_ASSET — eventos por activo (default 5; cada búsqueda cuesta 5 tokens NewsAPI)
 *   MONTHLY_INPUT_COST_PER_MILLION / MONTHLY_OUTPUT_COST_PER_MILLION — tarifas para log de coste
 *
 * Flags:
 *   --no-web-search — omite la búsqueda web de contexto de mercado
 *   --no-newsapi — omite el contraste con NewsAPI.ai
 *   --external-only — solo fases 1b/1c (web + NewsAPI); imprime el JSON y sale sin síntesis ni escritura
 *   --newsapi-historic — permite NewsAPI para meses de hace más de 31 días (cuesta 5–65x más tokens)
 */

import { requireVaultPath } from "./lib/layout.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { normalizeWithingsBodyMeasurements } from "../bridge/src/modules/withings/measures.js";
import { stripBinaryBlobs } from "../bridge/src/shared/utils.js";
import { recordUsage, normalizeUsage } from "../bridge/src/shared/llm-usage.js";
import { runClaude } from "../bridge/src/shared/claude-cli.js";
import {
  DEFAULT_BUDGET_ID,
  DEFAULT_TR_ACCOUNT_ID,
  DEFAULT_DAILY_NOTES_DIR,
  DEFAULT_PORTFOLIO_DOC,
  resolveTargetMonth,
  getPreviousMonth,
  getMonthRange,
  getNetWorthSinceMonth,
  discoverInboxDir,
  resolveOutputPath,
  listDailyNotesForMonth,
  listWeeklyReviewsForMonth,
  truncateText,
  sourceOk,
  sourceError,
  buildContextManifest,
  estimateTokens,
  estimateCostUsd,
  buildOutputMarkdown,
  filterDocumentsForMonth,
  findPreviousDocument,
  sha256Text,
  DEFAULT_ANCHOR_DOCS,
  listDocsTouchedInMonth,
  extractPortfolioHoldings,
  formatHoldingsForSearch,
  daysSince
} from "./lib/monthly.js";
import {
  DEFAULT_NEWSAPI_BASE_URL,
  NEWSAPI_TICKER_CONCEPTS,
  createNewsApiClient
} from "./lib/newsapi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const VAULT_ROOT = requireVaultPath();
const INBOX_DIR_ENV = process.env.INBOX_DIR?.trim() || "";
const BRIDGE_URL = (process.env.BRIDGE_URL || "http://localhost:3000").replace(/\/$/, "");
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || "";
const BUDGET_ID = process.env.MONTHLY_BUDGET_ID || DEFAULT_BUDGET_ID;
const TR_ACCOUNT_ID = process.env.MONTHLY_TR_ACCOUNT_ID || DEFAULT_TR_ACCOUNT_ID;
const REVIEW_DOC = process.env.MONTHLY_REVIEW_DOC?.trim() || "";
const MODEL = process.env.MONTHLY_SYNTHESIS_MODEL || "gpt-5.6-luna";
// Proveedor de la fase 2: "openai" (API OpenAI/DeepSeek, por defecto) o "claude" (Claude Code CLI con la sesión del usuario).
const PROVIDER = (process.env.MONTHLY_LLM_PROVIDER || "openai").trim().toLowerCase();
const USE_CLAUDE = PROVIDER === "claude";
const WEBSEARCH_MODEL = process.env.MONTHLY_WEBSEARCH_MODEL || "gpt-5.6-luna";
const PORTFOLIO_DOC = process.env.MONTHLY_PORTFOLIO_DOC?.trim() || DEFAULT_PORTFOLIO_DOC;
const ANCHOR_DOCS = process.env.MONTHLY_ANCHOR_DOCS?.trim()
  ? process.env.MONTHLY_ANCHOR_DOCS.split(",").map((s) => s.trim()).filter(Boolean)
  : DEFAULT_ANCHOR_DOCS;
// Con Claude la ventana es menor: por defecto ~450k chars (~130k tokens) en vez de 900k.
const MAX_CONTEXT_CHARS = Number(process.env.MONTHLY_MAX_CONTEXT_CHARS || (USE_CLAUDE ? 450_000 : 900_000));
const MAX_DOC_CHARS = Number(process.env.MONTHLY_MAX_DOC_CHARS || 60_000);
const MAX_TOUCHED_DOCS = Number(process.env.MONTHLY_MAX_TOUCHED_DOCS || 50);
const MAX_TOUCHED_DOCS_CHARS = Number(process.env.MONTHLY_MAX_TOUCHED_DOCS_CHARS || 400_000);
const HTTP_TIMEOUT_MS = Number(process.env.MONTHLY_HTTP_TIMEOUT_MS || 60_000);

const DEFAULT_DEEPSEEK_BASE = "https://api.deepseek.com";

const DRY = process.argv.includes("--dry-run");
const NO_WEB_SEARCH = process.argv.includes("--no-web-search");
const NO_NEWSAPI = process.argv.includes("--no-newsapi");
const EXTERNAL_ONLY = process.argv.includes("--external-only");
const NEWSAPI_HISTORIC = process.argv.includes("--newsapi-historic");
const NEWSAPI_KEY = process.env.NEWSAPI_KEY?.trim() || "";
const NEWSAPI_BASE_URL = process.env.NEWSAPI_BASE_URL?.trim() || DEFAULT_NEWSAPI_BASE_URL;
const NEWSAPI_CONCEPTS = (() => {
  try {
    return { ...NEWSAPI_TICKER_CONCEPTS, ...JSON.parse(process.env.MONTHLY_NEWSAPI_CONCEPTS || "{}") };
  } catch {
    console.warn("MONTHLY_NEWSAPI_CONCEPTS no es JSON válido; se ignora");
    return NEWSAPI_TICKER_CONCEPTS;
  }
})();
const NEWSAPI_LANG = process.env.MONTHLY_NEWSAPI_LANG ?? "eng";
const NEWSAPI_EVENTS_PER_ASSET = Number(process.env.MONTHLY_NEWSAPI_EVENTS_PER_ASSET || 5);
const WEBSEARCH_MAX_OUTPUT_TOKENS = Number(process.env.MONTHLY_WEBSEARCH_MAX_OUTPUT_TOKENS || 20_000);
const monthArgIdx = process.argv.findIndex((a) => a.startsWith("--month="));
const MONTH_ARG = monthArgIdx >= 0 ? process.argv[monthArgIdx].split("=")[1] : null;

function resolveOpenAIAuth() {
  return { apiKey: process.env.OPENAI_API_KEY?.trim() || "" };
}

function resolveMonthlySynthesisAuth() {
  let baseURL = process.env.MONTHLY_SYNTHESIS_BASE_URL?.trim() || undefined;
  if (!baseURL && /^deepseek/i.test(MODEL)) {
    baseURL = DEFAULT_DEEPSEEK_BASE;
  }
  const deepseekHost = Boolean(baseURL && /deepseek\.com/i.test(baseURL));

  let apiKey = process.env.MONTHLY_SYNTHESIS_API_KEY?.trim();
  if (!apiKey) {
    apiKey = deepseekHost
      ? process.env.DEEPSEEK_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim()
      : process.env.OPENAI_API_KEY?.trim() || process.env.DEEPSEEK_API_KEY?.trim();
  }
  return { apiKey: apiKey || "", baseURL };
}

function loadPromptTemplate() {
  const p = path.join(REPO_ROOT, "pipeline", "prompts", "monthly.md");
  if (!fs.existsSync(p)) {
    throw new Error(`Prompt no encontrado: ${p}`);
  }
  return fs.readFileSync(p, "utf8");
}

async function bridgeGet(apiPath, query = {}) {
  const url = new URL(`${BRIDGE_URL}${apiPath}`);
  for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { "X-API-Key": BRIDGE_API_KEY },
      signal: controller.signal
    });
    const text = await resp.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    if (!resp.ok) {
      throw new Error(json.error || `HTTP ${resp.status}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function safeBridge(name, apiPath, query = {}) {
  try {
    if (!BRIDGE_API_KEY) throw new Error("BRIDGE_API_KEY no configurada");
    const data = await bridgeGet(apiPath, query);
    return sourceOk(name, data);
  } catch (e) {
    return sourceError(name, e.message);
  }
}

function readVaultDoc(relPath, maxChars = MAX_DOC_CHARS) {
  const full = path.join(VAULT_ROOT, relPath);
  if (!fs.existsSync(full)) {
    return { status: "empty", content: null, error: "file_not_found", metadata: { relPath } };
  }
  try {
    const raw = fs.readFileSync(full, "utf8");
    const { text: cleaned, removed: blobChars } = stripBinaryBlobs(raw);
    const { text, truncated, originalChars, keptChars } = truncateText(cleaned, maxChars);
    return {
      status: "ok",
      content: text,
      error: null,
      metadata: {
        relPath,
        sha256: sha256Text(raw),
        truncated,
        originalChars,
        keptChars,
        blob_chars_removed: blobChars
      }
    };
  } catch (e) {
    return { status: "error", content: null, error: e.message, metadata: { relPath } };
  }
}

async function collectYnab(month, prevMonth, range) {
  const netWorth = getNetWorthSinceMonth(month, 6);
  const sections = {};

  const calls = [
    ["month_summary", "/v1/month-summary", { budget_id: BUDGET_ID, month }],
    ["spending_by_category", "/v1/spending-by-category", { budget_id: BUDGET_ID, month, top: 30 }],
    ["budget_vs_actual", "/v1/budget-vs-actual", { budget_id: BUDGET_ID, month }],
    ["compare_periods", "/v1/compare-periods", { budget_id: BUDGET_ID, month_a: month, month_b: prevMonth }],
    ["savings_rate", "/v1/savings-rate", { budget_id: BUDGET_ID, since_date: range.since, until_date: range.until }],
    ["spending_anomalies", "/v1/spending-anomalies", { budget_id: BUDGET_ID, month }],
    ["recurring_expenses", "/v1/recurring-expenses", { budget_id: BUDGET_ID, months: 3, until_date: range.until }],
    ["net_worth_history", "/v1/net-worth-history", {
      budget_id: BUDGET_ID,
      since_date: netWorth.since,
      until_date: netWorth.until,
      group_by: "month"
    }],
    ["market_pnl", "/v1/market-pnl", {
      budget_id: BUDGET_ID,
      account_id: TR_ACCOUNT_ID,
      since_date: range.since,
      until_date: range.until
    }]
  ];

  for (const [name, apiPath, query] of calls) {
    sections[name] = await safeBridge(name, apiPath, query);
  }

  // Explicar anomalías: traer el desglose por payee de cada categoría anómala,
  // para que la síntesis pueda inferir el motivo de la desviación (no solo el total).
  const anomalies = sections.spending_anomalies?.data?.anomalies || [];
  const topAnomalies = anomalies.slice(0, 8);
  const breakdowns = [];
  for (const a of topAnomalies) {
    if (!a.category_id) continue;
    const r = await safeBridge(
      `anomaly_breakdown_${a.category_name}`,
      "/v1/payee-breakdown",
      {
        budget_id: BUDGET_ID,
        category_id: a.category_id,
        since_date: range.since,
        until_date: range.until,
        type: "outflow",
        top: 20
      }
    );
    breakdowns.push({
      category_id: a.category_id,
      category_name: a.category_name,
      current_spending: a.current_spending,
      avg_spending: a.avg_spending,
      deviation_percent: a.deviation_percent,
      status: r.status,
      error: r.error,
      payees: r.status === "ok" ? r.data?.breakdown || [] : null
    });
  }
  sections.anomaly_breakdowns = sourceOk("anomaly_breakdowns", breakdowns, {
    count: breakdowns.length
  });

  return sections;
}

async function collectWithings(range) {
  const q = { startdateymd: range.since, enddateymd: range.until };
  const bodyRaw = await safeBridge("body_measurements", "/v1/withings/body-measurements", {
    startdate: range.since,
    enddate: range.until
  });
  const body_measurements =
    bodyRaw.status === "ok" && bodyRaw.data
      ? sourceOk("body_measurements", normalizeWithingsBodyMeasurements(bodyRaw.data), {
          measure_groups: bodyRaw.data?.measuregrps?.length ?? 0
        })
      : bodyRaw;

  return {
    status: await safeBridge("withings_status", "/v1/withings/status"),
    sleep_summary: await safeBridge("sleep_summary", "/v1/withings/sleep-summary", q),
    activity: await safeBridge("activity", "/v1/withings/activity", q),
    workouts: await safeBridge("workouts", "/v1/withings/workouts", q),
    body_measurements
  };
}

async function collectBills(month) {
  const listResult = await safeBridge("bills_list", "/v1/bills/documents");
  if (listResult.status === "error") {
    return { list: listResult, invoices: [] };
  }

  const allDocs = listResult.data?.documents || [];
  const monthDocs = filterDocumentsForMonth(allDocs, month);
  const invoices = [];

  for (const doc of monthDocs) {
    const prev = findPreviousDocument(allDocs, doc.document_type, month);
    const currentContent = await safeBridge(
      `bill_${doc.source}`,
      `/v1/bills/documents/${encodeURIComponent(doc.source)}`
    );
    let previousContent = null;
    if (prev?.source) {
      previousContent = await safeBridge(
        `bill_prev_${prev.source}`,
        `/v1/bills/documents/${encodeURIComponent(prev.source)}`
      );
    }
    invoices.push({
      current: { meta: doc, content: currentContent },
      previous: prev ? { meta: prev, content: previousContent } : null
    });
  }

  return {
    list: sourceOk("bills_list", { count: monthDocs.length, month }, { total_indexed: allDocs.length }),
    invoices
  };
}

async function collectJob(month) {
  const listResult = await safeBridge("job_list", "/v1/job/documents", { type: "nomina" });
  if (listResult.status === "error") {
    return { list: listResult, payslips: [] };
  }

  const allDocs = listResult.data?.documents || [];
  const monthDocs = filterDocumentsForMonth(allDocs, month);
  const payslips = [];

  for (const doc of monthDocs) {
    const prev = findPreviousDocument(allDocs, doc.document_type, month);
    const currentContent = await safeBridge(
      `nomina_${doc.source}`,
      `/v1/job/documents/${encodeURIComponent(doc.source)}`
    );
    let previousContent = null;
    if (prev?.source) {
      previousContent = await safeBridge(
        `nomina_prev_${prev.source}`,
        `/v1/job/documents/${encodeURIComponent(prev.source)}`
      );
    }
    payslips.push({
      current: { meta: doc, content: currentContent },
      previous: prev ? { meta: prev, content: previousContent } : null
    });
  }

  return {
    list: sourceOk("job_list", { count: monthDocs.length, month }, { total_indexed: allDocs.length }),
    payslips
  };
}

function collectVault(range) {
  const dailies = listDailyNotesForMonth(VAULT_ROOT, range.since, range.until);
  const dailyDocs = dailies.map((d) => {
    const read = readVaultDoc(d.relPath);
    return {
      date: d.date,
      relPath: d.relPath,
      status: read.status,
      content: read.content,
      error: read.error,
      metadata: read.metadata
    };
  });

  const weeklies = listWeeklyReviewsForMonth(VAULT_ROOT, range.since, range.until);
  const weeklyDocs = weeklies.map((w) => {
    const read = readVaultDoc(w.relPath);
    return {
      date: w.date,
      relPath: w.relPath,
      status: read.status,
      content: read.content,
      error: read.error,
      metadata: read.metadata
    };
  });

  const hpReview = REVIEW_DOC ? readVaultDoc(REVIEW_DOC) : { status: "empty", content: null, error: "not_configured", metadata: {} };
  const portfolioRead = PORTFOLIO_DOC ? readVaultDoc(PORTFOLIO_DOC) : { status: "empty", content: null, error: "not_configured", metadata: {} };

  // Documentos ancla (objetivos/tesis/decisiones): estado declarado, siempre incluidos.
  const anchorDocs = ANCHOR_DOCS.map((relPath) => {
    const read = readVaultDoc(relPath);
    return {
      relPath,
      status: read.status,
      content: read.content,
      error: read.error,
      metadata: read.metadata
    };
  });

  // Documentos vivos de Personal y Work tocados durante el mes (señal de atención).
  // Se excluyen los ya incluidos por otra vía para no duplicar contexto.
  const alreadyIncluded = new Set([REVIEW_DOC, PORTFOLIO_DOC, ...ANCHOR_DOCS].filter(Boolean));
  let touchedDocs = [];
  let touchedTotal = 0;
  try {
    const touchedDirs = (process.env.MONTHLY_TOUCHED_DIRS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const touched = listDocsTouchedInMonth(VAULT_ROOT, range.since, range.until, {
      excludeRelPaths: [...alreadyIncluded],
      ...(touchedDirs.length ? { dirs: touchedDirs } : {})
    });
    touchedTotal = touched.length;
    let usedChars = 0;
    touchedDocs = touched.slice(0, MAX_TOUCHED_DOCS).map((t) => {
      // Presupuesto total: pasado el límite, solo metadatos (el LLM sabe que se tocó).
      if (usedChars >= MAX_TOUCHED_DOCS_CHARS) {
        return {
          relPath: t.relPath,
          modified_on: t.mtimeDate,
          status: "listed_only",
          content: null,
          note: "contenido omitido por presupuesto de contexto"
        };
      }
      const read = readVaultDoc(t.relPath, Math.floor(MAX_DOC_CHARS / 2));
      usedChars += read.content?.length || 0;
      return {
        relPath: t.relPath,
        modified_on: t.mtimeDate,
        status: read.status,
        content: read.content,
        error: read.error,
        metadata: read.metadata
      };
    });
  } catch (e) {
    touchedDocs = null;
    console.warn(`No se pudieron listar docs tocados en el mes: ${e.message}`);
  }

  return {
    dailies: sourceOk("vault_dailies", dailyDocs, {
      count: dailyDocs.length,
      skipped_template_only: 0
    }),
    weeklies: sourceOk("vault_weeklies", weeklyDocs, { count: weeklyDocs.length }),
    hp_performance_review: hpReview.status === "ok" && hpReview.content
      ? sourceOk("review", { relPath: REVIEW_DOC, content: hpReview.content }, hpReview.metadata)
      : hpReview.status === "empty"
        ? sourceError("review", "file_not_found")
        : sourceError("review", hpReview.error || "read_error"),
    portfolio: portfolioRead.status === "ok" && portfolioRead.content
      ? sourceOk("portfolio", { relPath: PORTFOLIO_DOC, content: portfolioRead.content }, portfolioRead.metadata)
      : portfolioRead.status === "empty"
        ? sourceError("portfolio", "file_not_found")
        : sourceError("portfolio", portfolioRead.error || "read_error"),
    anchors: sourceOk("vault_anchors", anchorDocs, { count: anchorDocs.length }),
    touched_docs: touchedDocs === null
      ? sourceError("vault_touched_docs", "walk_error")
      : sourceOk("vault_touched_docs", touchedDocs, {
          count: touchedDocs.length,
          total_touched_in_month: touchedTotal,
          truncated_list: touchedTotal > touchedDocs.length
        })
  };
}

/** @param {import("openai").default} client @param {unknown} response */
function extractWebSearchCitations(response) {
  const citations = [];
  const seen = new Set();
  for (const item of response?.output || []) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      for (const ann of block.annotations || []) {
        if (ann.type === "url_citation" && ann.url && !seen.has(ann.url)) {
          seen.add(ann.url);
          citations.push({ url: ann.url, title: ann.title || null });
        }
      }
    }
  }
  return citations;
}

/**
 * @param {{ month: string, since: string, until: string, holdings: ReturnType<typeof extractPortfolioHoldings>, portfolioContent: string | null }} opts
 */
async function collectMarketContext({ month, since, until, holdings, portfolioContent }) {
  const { apiKey } = resolveOpenAIAuth();
  if (!apiKey) {
    return { result: sourceError("market_context", "OPENAI_API_KEY no configurada"), usage: null };
  }

  // Antes se mandaba el portfolio.md recortado a 8.000 chars: el corte caía a mitad de la
  // tabla de acciones y el buscador no veía ZZZT, ZZZU ni los ETFs.
  const holdingsSnippet = holdings.length > 0
    ? formatHoldingsForSearch(holdings)
    : portfolioContent
      ? truncateText(portfolioContent, 8_000).text
      : "(portfolio no disponible en el vault)";
  const tickers = holdings.filter((h) => h.ticker).map((h) => h.ticker);

  const input = [
    `Investiga y resume en español los eventos de mercado y mundo más relevantes ocurridos entre ${since} y ${until} (mes ${month})`,
    "que puedan haber afectado a estas posiciones.",
    "",
    "Posiciones vivas (lista completa):",
    holdingsSnippet,
    "",
    "Instrucciones:",
    "- Empieza con 3–5 líneas de macro del mes (tipos, petróleo, índices) con fechas.",
    `- Después, UNA entrada por cada acción, sin saltarte ninguna: ${tickers.join(", ") || "(ninguna)"}.`,
    "  Cada entrada: fecha(s), qué pasó y fuente. Si no encuentras nada verificable del periodo, escribe «sin noticias verificables».",
    "- Para los ETFs y la crypto basta con una línea por sector o activo.",
    "- Máximo ~1.200 palabras. Texto plano markdown (no JSON)."
  ].join("\n");

  try {
    const client = new OpenAI({ apiKey });
    const res = await client.responses.create({
      model: WEBSEARCH_MODEL,
      tools: [{ type: "web_search" }],
      max_output_tokens: WEBSEARCH_MAX_OUTPUT_TOKENS,
      input
    });

    const summary = (res.output_text || "").trim();
    const incomplete = res.status === "incomplete";
    const incompleteReason = res.incomplete_details?.reason || null;
    if (!summary) {
      return {
        result: sourceError(
          "market_context",
          incomplete ? `respuesta incompleta de web_search (${incompleteReason})` : "respuesta vacía de web_search"
        ),
        usage: res.usage || null
      };
    }

    const citations = extractWebSearchCitations(res);
    const missing = tickers.filter((t) => !new RegExp(`\\b${t.replace(".", "\\.")}\\b`).test(summary));
    return {
      result: sourceOk(
        "market_context",
        { summary, citations, model: WEBSEARCH_MODEL },
        {
          metadata: {
            citation_count: citations.length,
            truncated: incomplete,
            ...(incomplete ? { incomplete_reason: incompleteReason } : {}),
            tickers_requested: tickers.length,
            tickers_not_mentioned: missing
          }
        }
      ),
      usage: res.usage || null
    };
  } catch (e) {
    return { result: sourceError("market_context", e.message), usage: null };
  }
}

/**
 * Contraste independiente del contexto de mercado con NewsAPI.ai (Event Registry, API REST).
 * Por cada acción viva trae los eventos más relevantes del mes (clusters deduplicados
 * con nº de artículos). Coste: 5 tokens NewsAPI por activo.
 *
 * @param {{ since: string, until: string, holdings: ReturnType<typeof extractPortfolioHoldings> }} opts
 */
async function collectNewsVerification({ since, until, holdings }) {
  if (!NEWSAPI_KEY) return sourceError("news_verification", "NEWSAPI_KEY no configurada");
  const age = daysSince(since);
  if (age > 31 && !NEWSAPI_HISTORIC) {
    return sourceError(
      "news_verification",
      `el mes empieza hace ${age} días; fuera de la ventana de 31 días NewsAPI cobra 5–65x más. Usa --newsapi-historic para forzarlo`
    );
  }

  const assets = holdings
    .filter((h) => h.kind === "stock" && h.ticker)
    .map((h) => ({ ticker: h.ticker, name: h.name }));
  const api = createNewsApiClient({ apiKey: NEWSAPI_KEY, baseUrl: NEWSAPI_BASE_URL, timeoutMs: HTTP_TIMEOUT_MS });
  const before = await api.usage();

  const results = [];
  for (const asset of assets) {
    try {
      let conceptUri = NEWSAPI_CONCEPTS[asset.ticker] || null;
      let resolvedBy = "map";
      if (!conceptUri && asset.name) {
        conceptUri = (await api.suggestConcept(asset.name))?.uri || null;
        resolvedBy = "name";
      }
      if (!conceptUri) {
        results.push({ ...asset, status: "unresolved", events: [] });
        continue;
      }
      const { events, total } = await api.topEvents({
        conceptUri,
        dateStart: since,
        dateEnd: until,
        count: NEWSAPI_EVENTS_PER_ASSET,
        lang: NEWSAPI_LANG
      });
      results.push({ ...asset, concept_uri: conceptUri, resolved_by: resolvedBy, status: "ok", total_events: total, events });
    } catch (e) {
      results.push({ ...asset, status: "error", error: e.message, events: [] });
      // Un error de auth afecta a todas las llamadas: no gastes el resto.
      if (/apiKey|not recognized|unauthor/i.test(e.message)) break;
    }
  }

  const after = await api.usage();
  const failed = results.filter((r) => r.status !== "ok");
  if (failed.length === results.length) {
    return sourceError("news_verification", `todas las consultas fallaron: ${failed[0]?.error || failed[0]?.status}`);
  }
  return sourceOk("news_verification", results, {
    metadata: {
      provider: "NewsAPI.ai (Event Registry)",
      assets: results.length,
      failed: failed.map((r) => `${r.ticker}: ${r.error || r.status}`),
      newsapi_tokens_used:
        before?.usedTokens != null && after?.usedTokens != null ? after.usedTokens - before.usedTokens : null,
      newsapi_tokens_available: after?.availableTokens ?? null
    }
  });
}

function trimContextJson(context) {
  let serialized = JSON.stringify(context);
  if (serialized.length <= MAX_CONTEXT_CHARS) {
    return { context, trimmed: false, chars: serialized.length };
  }

  const trimmed = structuredClone(context);
  const vault = trimmed.vault;

  // Capa 1: degradar touched_docs (fuente secundaria) a solo-metadatos antes de tocar dailies.
  if (vault?.touched_docs?.data && Array.isArray(vault.touched_docs.data)) {
    for (const d of vault.touched_docs.data) {
      if (d.content) {
        d.content = null;
        d.status = "listed_only";
        d.note = "contenido omitido por presupuesto de contexto";
      }
    }
  }
  serialized = JSON.stringify(trimmed);
  if (serialized.length <= MAX_CONTEXT_CHARS) {
    trimmed._context_note = { trimmed: true, reason: "touched_docs_reduced", chars: serialized.length };
    return { context: trimmed, trimmed: true, chars: serialized.length };
  }

  // Capa 2: recortar dailies.
  if (vault?.dailies?.data && Array.isArray(vault.dailies.data)) {
    for (const d of vault.dailies.data) {
      if (d.content) {
        const t = truncateText(d.content, Math.floor(MAX_DOC_CHARS / 2));
        d.content = t.text;
        d.metadata = { ...d.metadata, truncated: t.truncated };
      }
    }
  }
  serialized = JSON.stringify(trimmed);
  if (serialized.length <= MAX_CONTEXT_CHARS) {
    trimmed._context_note = { trimmed: true, reason: "dailies_reduced", chars: serialized.length };
    return { context: trimmed, trimmed: true, chars: serialized.length };
  }

  trimmed._context_note = {
    trimmed: true,
    reason: "still_large_after_dailies_reduction",
    chars: serialized.length,
    max: MAX_CONTEXT_CHARS
  };
  return { context: trimmed, trimmed: true, chars: serialized.length };
}

const LLM_RETRIES = 2;
const LLM_RETRY_DELAY_MS = 3_000;

function safeParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    // continue
  }
  let cleaned = raw;
  const fenced = raw.match(/```json\s*([\s\S]*?)```/);
  if (fenced) cleaned = fenced[1].trim();
  else {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last > first) cleaned = cleaned.slice(first, last + 1);
  }
  cleaned = cleaned.replace(/\\([^"\\\/bfnrtu])/g, "$1");
  return JSON.parse(cleaned);
}

async function llmCall(client, system, user, { month, step = "monthly", parseRetry = 0 } = {}) {
  const payload = {
    model: MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  };
  const temp = process.env.MONTHLY_SYNTHESIS_TEMPERATURE;
  if (temp != null && temp !== "") {
    payload.temperature = Number(temp);
  }

  // GPT-5.6+: prompt_cache_key obligatorio para matching fiable.
  // https://developers.openai.com/api/docs/guides/prompt-caching
  if (/^gpt-5\.[6-9]|^gpt-[6-9]/.test(MODEL)) {
    payload.prompt_cache_key = `monthly:${month || "unknown"}`;
    const mode = process.env.MONTHLY_PROMPT_CACHE || "implicit";
    if (mode === "explicit") {
      payload.prompt_cache_options = { mode: "explicit" };
      payload.messages[0] = {
        role: "system",
        content: [{ type: "text", text: system, prompt_cache_breakpoint: { mode: "explicit" } }]
      };
    } else if (mode === "off") {
      payload.prompt_cache_options = { mode: "explicit" };
      // sin breakpoints → sin caching ni write charges
    }
  }

  const res = await client.chat.completions.create(payload);
  recordUsage({
    step,
    model: MODEL,
    usage: res.usage,
    message: res.choices?.[0]?.message,
    extra: {
      system_chars: system.length,
      user_chars: user.length,
      parse_retry: parseRetry,
      month: month || null
    }
  });
  return res;
}

async function synthesizeMonthly(client, promptTemplate, contextJson) {
  const userPayload = `Mes analizado: ${contextJson.meta.month}\nRango: ${contextJson.meta.since} — ${contextJson.meta.until}\n\nContexto JSON:\n${JSON.stringify(contextJson, null, 2)}`;
  const system = promptTemplate;
  const month = contextJson.meta.month;

  let lastErr;
  let lastText = "";
  for (let attempt = 0; attempt <= LLM_RETRIES; attempt++) {
    try {
      let res;
      if (
        attempt === 1 &&
        lastText &&
        process.env.MONTHLY_JSON_REPAIR !== "off"
      ) {
        // Reparo solo el JSON roto; no reenvío el contexto de 150k tokens.
        res = await client.chat.completions.create({
          model: MODEL,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: "Devuelves exclusivamente JSON válido. No añades comentarios ni fences."
            },
            {
              role: "user",
              content: `Corrige este texto para que sea JSON válido con campo "markdown", preservando el contenido literal:\n\n${lastText.slice(0, 60_000)}`
            }
          ]
        });
        recordUsage({
          step: "monthly:repair",
          model: MODEL,
          usage: res.usage,
          message: res.choices?.[0]?.message
        });
      } else {
        res = await llmCall(client, system, userPayload, {
          month,
          step: "monthly",
          parseRetry: attempt
        });
      }
      const text = res.choices?.[0]?.message?.content || "{}";
      lastText = text;
      const obj = safeParseJson(text);
      if (typeof obj.markdown !== "string") throw new Error("Respuesta sin campo markdown");
      return {
        markdown: obj.markdown.trim(),
        usage: res.usage || null
      };
    } catch (e) {
      lastErr = e;
      console.warn(`  LLM error (attempt ${attempt + 1}/${LLM_RETRIES + 1}): ${e.message.slice(0, 120)}`);
      if (attempt < LLM_RETRIES) {
        await new Promise((r) => setTimeout(r, LLM_RETRY_DELAY_MS));
      }
    }
  }
  throw lastErr || new Error("Síntesis fallida");
}

/**
 * Fase 2 con Claude Code CLI: mismo prompt y mismo contexto que la vía OpenAI.
 * El contexto va por stdin; Claude no usa herramientas (todo está en el JSON).
 */
async function synthesizeMonthlyClaude(promptTemplate, contextJson) {
  const userPayload = `Mes analizado: ${contextJson.meta.month}\nRango: ${contextJson.meta.since} — ${contextJson.meta.until}\n\nContexto JSON:\n${JSON.stringify(contextJson, null, 2)}`;
  const prompt =
    `${promptTemplate}\n\n---\nEl contexto del mes te llega por la entrada estándar. ` +
    "No uses herramientas: todo lo que necesitas está en ese contexto. " +
    'Devuelve exclusivamente un objeto JSON válido con la clave "markdown", sin fences ni texto adicional.';

  let lastErr;
  for (let attempt = 0; attempt <= LLM_RETRIES; attempt++) {
    try {
      const res = await runClaude({
        prompt,
        stdin: userPayload,
        cwd: REPO_ROOT,
        disallowedTools: ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task"],
        maxTurns: 3
      });
      recordUsage({
        step: "monthly",
        model: "claude-cli",
        usage: res.usage,
        extra: { provider: "claude", cost_usd_reported: res.costUsd, parse_retry: attempt, month: contextJson.meta.month }
      });
      const obj = safeParseJson(res.text || "{}");
      if (typeof obj.markdown !== "string") throw new Error("Respuesta sin campo markdown");
      return { markdown: obj.markdown.trim(), usage: res.usage || null, costUsd: res.costUsd };
    } catch (e) {
      lastErr = e;
      console.warn(`  Claude error (attempt ${attempt + 1}/${LLM_RETRIES + 1}): ${String(e.message).slice(0, 160)}`);
      if (e.kind === "auth") break; // sesión caducada: reintentar no sirve
      if (attempt < LLM_RETRIES) await new Promise((r) => setTimeout(r, LLM_RETRY_DELAY_MS));
    }
  }
  throw lastErr || new Error("Síntesis fallida (claude)");
}

function printDryRunSummary(manifest, contextCharCount, costEstimate, webSearchNote) {
  console.log("\n=== DRY RUN — resumen ===");
  console.log(`Fuentes: ${manifest.ok} ok, ${manifest.empty} vacías, ${manifest.errors} errores`);
  for (const s of manifest.sources) {
    const extra = [];
    if (s.count != null) extra.push(`count=${s.count}`);
    if (s.chars != null) extra.push(`chars=${s.chars}`);
    console.log(`  [${s.status}] ${s.source}${extra.length ? ` (${extra.join(", ")})` : ""}${s.error ? ` — ${s.error}` : ""}`);
  }
  if (webSearchNote) console.log(`  Búsqueda web: ${webSearchNote}`);
  console.log(`Contexto JSON: ~${contextCharCount} chars (~${Math.ceil(contextCharCount / 4)} tokens estimados)`);
  console.log(`Coste estimado síntesis (sin llamada LLM): ~$${costEstimate.toFixed(4)} USD`);
  console.log("No se llamó al LLM ni se escribió archivo.\n");
}

async function main() {
  const targetMonth = resolveTargetMonth(MONTH_ARG);
  const prevMonth = getPreviousMonth(targetMonth);
  const range = getMonthRange(targetMonth);

  console.log(`Monthly: mes objetivo ${targetMonth} (${range.since} — ${range.until})`);
  if (DRY) console.log("Modo --dry-run activo");

  if (!fs.existsSync(VAULT_ROOT)) {
    console.error(`Vault no encontrado: ${VAULT_ROOT}`);
    process.exit(1);
  }

  const inboxDir = discoverInboxDir(VAULT_ROOT, INBOX_DIR_ENV || undefined);
  console.log(`Inbox: ${inboxDir}`);

  console.log("\n── Fase 1: recolección ──\n");

  const [ynab, withings, bills, job] = await Promise.all([
    collectYnab(targetMonth, prevMonth, range),
    collectWithings(range),
    collectBills(targetMonth),
    collectJob(targetMonth)
  ]);
  const vault = collectVault(range);

  const portfolioContent =
    vault.portfolio?.status === "ok" ? vault.portfolio.data?.content : null;
  const holdings = extractPortfolioHoldings(portfolioContent);
  console.log(`Posiciones vivas en portfolio: ${holdings.length}`);

  let marketContextResult;
  let marketUsage = null;
  let webSearchNote = null;

  if (DRY) {
    webSearchNote = "omitida en dry-run";
    marketContextResult = sourceError("market_context", "omitido en dry-run");
  } else if (NO_WEB_SEARCH) {
    webSearchNote = "desactivada (--no-web-search)";
    marketContextResult = sourceError("market_context", "desactivado con --no-web-search");
  } else {
    console.log(`\n── Fase 1b: contexto mercado (web_search, ${WEBSEARCH_MODEL}) ──\n`);
    const { result, usage } = await collectMarketContext({
      month: targetMonth,
      since: range.since,
      until: range.until,
      holdings,
      portfolioContent
    });
    marketContextResult = result;
    marketUsage = usage;
    if (result.status === "ok") {
      const md = result.metadata || {};
      console.log(`Contexto mercado OK (${md.citation_count ?? 0} citas, ${md.tickers_requested} tickers pedidos)`);
      if (md.truncated) console.warn(`⚠ Respuesta de web_search incompleta (${md.incomplete_reason})`);
      if (md.tickers_not_mentioned?.length) {
        console.warn(`⚠ Tickers sin mención en el resumen: ${md.tickers_not_mentioned.join(", ")}`);
      }
    } else {
      console.warn(`Contexto mercado falló: ${result.error}`);
    }
  }

  let newsVerificationResult;
  if (DRY) {
    newsVerificationResult = sourceError("news_verification", "omitido en dry-run");
  } else if (NO_NEWSAPI) {
    newsVerificationResult = sourceError("news_verification", "desactivado con --no-newsapi");
  } else {
    console.log(`\n── Fase 1c: contraste NewsAPI.ai (${NEWSAPI_BASE_URL}) ──\n`);
    newsVerificationResult = await collectNewsVerification({
      since: range.since,
      until: range.until,
      holdings
    });
    if (newsVerificationResult.status === "ok") {
      const md = newsVerificationResult.metadata || {};
      console.log(
        `NewsAPI OK: ${md.assets} activos, ${md.newsapi_tokens_used} tokens gastados` +
          (md.newsapi_tokens_available != null ? `, plan: ${md.newsapi_tokens_available}` : "")
      );
      if (md.failed?.length) console.warn(`⚠ NewsAPI sin resultado para: ${md.failed.join("; ")}`);
    } else {
      console.warn(`NewsAPI no disponible: ${newsVerificationResult.error}`);
    }
  }

  if (EXTERNAL_ONLY) {
    console.log(JSON.stringify({ market_context: marketContextResult, news_verification: newsVerificationResult }, null, 2));
    return;
  }

  const context = {
    meta: {
      month: targetMonth,
      previous_month: prevMonth,
      since: range.since,
      until: range.until,
      generated_at: new Date().toISOString(),
      bridge_url: BRIDGE_URL
    },
    ynab,
    withings,
    bills,
    job,
    vault,
    external: {
      market_context: marketContextResult,
      news_verification: newsVerificationResult
    }
  };

  const { context: finalContext, trimmed, chars: contextChars } = trimContextJson(context);
  if (trimmed) console.warn("Contexto recortado para caber en presupuesto");

  const flatSections = {
    ...Object.fromEntries(Object.entries(ynab).map(([k, v]) => [`ynab.${k}`, v])),
    "withings.status": withings.status,
    "withings.sleep": withings.sleep_summary,
    "withings.activity": withings.activity,
    "withings.workouts": withings.workouts,
    "withings.body": withings.body_measurements,
    "bills.list": bills.list,
    "job.list": job.list,
    "vault.dailies": vault.dailies,
    "vault.weeklies": vault.weeklies,
    "vault.hp_review": vault.hp_performance_review,
    "vault.portfolio": vault.portfolio,
    "vault.anchors": vault.anchors,
    "vault.touched_docs": vault.touched_docs,
    "external.market_context": marketContextResult,
    "external.news_verification": newsVerificationResult
  };
  const manifest = buildContextManifest(flatSections);

  const promptTemplate = loadPromptTemplate();
  const contextJsonStr = JSON.stringify(finalContext);
  const estPromptTokens = estimateTokens(promptTemplate + contextJsonStr);
  const estCompletionTokens = 4_000;
  const inputRate = process.env.MONTHLY_INPUT_COST_PER_MILLION
    ? Number(process.env.MONTHLY_INPUT_COST_PER_MILLION) : undefined;
  const outputRate = process.env.MONTHLY_OUTPUT_COST_PER_MILLION
    ? Number(process.env.MONTHLY_OUTPUT_COST_PER_MILLION) : undefined;
  const estCost = estimateCostUsd(estPromptTokens, estCompletionTokens, MODEL, {
    inputPerMillion: inputRate,
    outputPerMillion: outputRate
  });

  if (DRY) {
    printDryRunSummary(manifest, contextJsonStr.length, estCost, webSearchNote);
    return;
  }

  const { apiKey, baseURL } = resolveMonthlySynthesisAuth();
  if (!apiKey && !USE_CLAUDE) {
    console.error("Clave API requerida: OPENAI_API_KEY o MONTHLY_SYNTHESIS_API_KEY (o MONTHLY_LLM_PROVIDER=claude)");
    process.exit(1);
  }

  if (marketUsage) {
    const wsIn = marketUsage.input_tokens ?? 0;
    const wsOut = marketUsage.output_tokens ?? 0;
    const wsCost = estimateCostUsd(wsIn, wsOut, WEBSEARCH_MODEL, {
      inputPerMillion: inputRate,
      outputPerMillion: outputRate
    });
    console.log(
      `\nWeb search: prompt=${wsIn} completion=${wsOut} | Coste ~$${wsCost.toFixed(4)} USD`
    );
  }

  console.log(`\n── Fase 2: síntesis LLM (${USE_CLAUDE ? "Claude Code CLI" : MODEL}) ──\n`);
  let markdown;
  let usage;
  if (USE_CLAUDE) {
    const r = await synthesizeMonthlyClaude(promptTemplate, finalContext);
    markdown = r.markdown;
    const nuc = normalizeUsage(r.usage);
    console.log(
      `Síntesis (Claude): prompt=${nuc?.prompt ?? "?"} completion=${nuc?.completion ?? "?"}` +
        (r.costUsd != null ? ` | coste equivalente reportado ~$${r.costUsd.toFixed(4)} (plan, no factura aparte)` : "")
    );
  } else {
    const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
    ({ markdown, usage } = await synthesizeMonthly(client, promptTemplate, finalContext));

    const promptTokens = usage?.prompt_tokens ?? estPromptTokens;
    const completionTokens = usage?.completion_tokens ?? estCompletionTokens;
    const synthCost = estimateCostUsd(promptTokens, completionTokens, MODEL, {
      inputPerMillion: inputRate,
      outputPerMillion: outputRate
    });
    const nu = normalizeUsage(usage);
    console.log(
      `Síntesis: prompt=${promptTokens} completion=${completionTokens}` +
        (nu ? ` cached=${nu.cached} miss=${nu.miss} write=${nu.cacheWrite} hit=${(nu.hitRate * 100).toFixed(1)}%` : "") +
        ` | Coste ~$${synthCost.toFixed(4)} USD`
    );
    if (promptTokens > 250_000) {
      console.warn(
        `⚠ prompt=${promptTokens} tokens — cerca del umbral de long context de ${MODEL}, ` +
          `donde la tarifa se DOBLA. Revisa MONTHLY_MAX_CONTEXT_CHARS.`
      );
    }
  }

  console.log("\n── Fase 3: escritura ──\n");
  const { path: outPath, filename, version } = resolveOutputPath(inboxDir, targetMonth);
  if (version > 1) {
    console.warn(`Archivo base ya existía; escribiendo ${filename}`);
  }

  const output = buildOutputMarkdown(targetMonth, markdown);
  fs.writeFileSync(outPath, output, { encoding: "utf8", flag: "wx" });
  console.log(`Escrito: ${outPath}`);

  if (manifest.errors > 0) {
    console.warn(`\nFuentes con error (${manifest.errors}):`);
    for (const e of manifest.error_details) {
      console.warn(`  - ${e.source}: ${e.error}`);
    }
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
