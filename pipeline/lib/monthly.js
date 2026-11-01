import fs from "fs";
import path from "path";
import crypto from "crypto";
import { extractDateFromFilename, normalizeSearchDate } from "../../bridge/src/shared/brain-date.js";
import { walkMarkdownFiles } from "./vault-diff.js";

const MONTH_RE = /^\d{4}-\d{2}$/;

const SPANISH_MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"
];

export const DEFAULT_BUDGET_ID = "";
export const DEFAULT_TR_ACCOUNT_ID = "";
export const DEFAULT_DAILY_NOTES_DIR = "🗓️ Daily notes";
export const DEFAULT_INBOX_DIR = "📥 Inbox";
export const DEFAULT_WIKI_DIR = "📒 Wiki";
export const DEFAULT_PORTFOLIO_DOC = "";
export const DEFAULT_ANCHOR_DOCS = [];
export const DEFAULT_TOUCHED_DOC_DIRS = ["🚀 Personal", "💼 Work"];
export const DEFAULT_TOUCHED_DOC_EXCLUDES = ["🗂️ Archive"];

/** @typedef {"ok"|"empty"|"error"} SourceStatus */

/**
 * @param {string | undefined} monthArg YYYY-MM from --month=
 * @param {Date} [now]
 */
export function resolveTargetMonth(monthArg, now = new Date()) {
  if (monthArg != null && monthArg !== "") {
    if (!MONTH_RE.test(monthArg)) {
      throw new Error(`--month inválido: "${monthArg}" (esperado YYYY-MM)`);
    }
    const mo = Number(monthArg.split("-")[1]);
    if (mo < 1 || mo > 12) {
      throw new Error(`--month inválido: "${monthArg}" (mes fuera de rango 01-12)`);
    }
    return monthArg;
  }
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-based; current month
  if (m === 0) return `${y - 1}-12`;
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** @param {string} month YYYY-MM */
export function getPreviousMonth(month) {
  const [y, mo] = month.split("-").map(Number);
  if (mo === 1) return `${y - 1}-12`;
  return `${y}-${String(mo - 1).padStart(2, "0")}`;
}

/** @param {string} month YYYY-MM */
export function getMonthRange(month) {
  const since = normalizeSearchDate(month, { boundary: "start" });
  const until = normalizeSearchDate(month, { boundary: "end" });
  if (!since || !until) throw new Error(`Mes inválido: ${month}`);
  return { month, since, until };
}

/** @param {string} month YYYY-MM @param {number} count */
export function getNetWorthSinceMonth(month, count = 6) {
  const [y, mo] = month.split("-").map(Number);
  const d = new Date(y, mo - 1 - (count - 1), 1);
  const since = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  const until = normalizeSearchDate(month, { boundary: "end" });
  return { since, until };
}

/** @param {string} month YYYY-MM */
export function spanishMonthName(month) {
  const mo = Number(month.split("-")[1]);
  return SPANISH_MONTHS[mo - 1] || month;
}

/** @param {string} month YYYY-MM */
export function buildBaseFilename(month) {
  return `monthly-${month}-${spanishMonthName(month)}.md`;
}

/**
 * @param {string} inboxDir absolute path
 * @param {string} month YYYY-MM
 */
export function resolveOutputPath(inboxDir, month) {
  const base = buildBaseFilename(month);
  let candidate = path.join(inboxDir, base);
  if (!fs.existsSync(candidate)) {
    return { path: candidate, filename: base, version: 1 };
  }
  let version = 2;
  while (version < 100) {
    const stem = `monthly-${month}-${spanishMonthName(month)}-v${version}`;
    const filename = `${stem}.md`;
    candidate = path.join(inboxDir, filename);
    if (!fs.existsSync(candidate)) {
      return { path: candidate, filename, version };
    }
    version++;
  }
  throw new Error(`Demasiadas versiones existentes para ${month}`);
}

/**
 * @param {string} vaultRoot
 * @param {string} [inboxDirEnv] relative INBOX_DIR
 */
export function discoverInboxDir(vaultRoot, inboxDirEnv) {
  if (inboxDirEnv) {
    const resolved = path.join(vaultRoot, inboxDirEnv);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`INBOX_DIR no encontrado: ${resolved}`);
    }
    return resolved;
  }

  const exact = path.join(vaultRoot, DEFAULT_INBOX_DIR);
  if (fs.existsSync(exact) && fs.statSync(exact).isDirectory()) {
    return exact;
  }

  const entries = fs.readdirSync(vaultRoot, { withFileTypes: true });
  const candidates = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => name.includes("Inbox") || name.startsWith("📥"));

  if (candidates.length === 1) {
    return path.join(vaultRoot, candidates[0]);
  }
  if (candidates.length === 0) {
    throw new Error(`No se encontró carpeta inbox en ${vaultRoot}`);
  }
  throw new Error(`Inbox ambiguo (${candidates.length} candidatos): ${candidates.join(", ")}`);
}

/**
 * @param {string} relPath
 * @param {string} since YYYY-MM-DD
 * @param {string} until YYYY-MM-DD
 */
export function isDateInRange(relPath, since, until) {
  const d = extractDateFromFilename(relPath);
  if (!d) return false;
  return d >= since && d <= until;
}

/**
 * @param {string} vaultRoot
 * @param {string} since
 * @param {string} until
 * @param {string} [dailyDirName]
 */
export function listDailyNotesForMonth(vaultRoot, since, until, dailyDirName = DEFAULT_DAILY_NOTES_DIR) {
  const dailyRoot = path.join(vaultRoot, dailyDirName);
  if (!fs.existsSync(dailyRoot)) return [];

  const files = walkMarkdownFiles(dailyRoot);
  return files
    .filter((f) => isDateInRange(f.relPath, since, until))
    .map((f) => ({
      relPath: path.join(dailyDirName, f.relPath).split(path.sep).join("/"),
      fullPath: f.fullPath,
      date: extractDateFromFilename(f.relPath)
    }))
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
}

/**
 * Weekly reviews: path contains "Weekly" (case-insensitive), date from filename in range, exclude wiki copies.
 * @param {string} vaultRoot
 * @param {string} since
 * @param {string} until
 * @param {string} [wikiDirName]
 */
export function listWeeklyReviewsForMonth(vaultRoot, since, until, wikiDirName = DEFAULT_WIKI_DIR) {
  const wikiPrefix = `${wikiDirName}/`;
  const files = walkMarkdownFiles(vaultRoot);
  return files
    .filter((f) => {
      const rel = f.relPath.split(path.sep).join("/");
      if (rel.startsWith(wikiPrefix)) return false;
      if (!/weekly/i.test(rel)) return false;
      return isDateInRange(rel, since, until);
    })
    .map((f) => ({
      relPath: f.relPath.split(path.sep).join("/"),
      fullPath: f.fullPath,
      date: extractDateFromFilename(f.relPath)
    }))
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
}

/** @param {Date} d local date as YYYY-MM-DD */
function localDateString(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Documentos vivos (Personal y Work) modificados durante el mes según mtime.
 * La fecha de modificación es una señal de atención, no garantiza que el contenido
 * hable solo del mes (el consumidor debe mirar fechas internas).
 *
 * @param {string} vaultRoot
 * @param {string} since YYYY-MM-DD
 * @param {string} until YYYY-MM-DD
 * El orden de `dirs` marca la prioridad (los primeros consumen antes el presupuesto
 * de contexto del consumidor); dentro de cada dir, mtime descendente.
 *
 * @param {{ dirs?: string[], excludeDirParts?: string[], excludeRelPaths?: string[] }} [opts]
 * @returns {Array<{ relPath: string, fullPath: string, mtimeDate: string, size: number }>}
 */
export function listDocsTouchedInMonth(vaultRoot, since, until, opts = {}) {
  const dirs = opts.dirs || DEFAULT_TOUCHED_DOC_DIRS;
  const excludeParts = opts.excludeDirParts || DEFAULT_TOUCHED_DOC_EXCLUDES;
  const excludeRel = new Set(opts.excludeRelPaths || []);
  const out = [];

  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i];
    const root = path.join(vaultRoot, dir);
    const files = walkMarkdownFiles(root);
    for (const f of files) {
      const rel = path.join(dir, f.relPath).split(path.sep).join("/");
      if (excludeRel.has(rel)) continue;
      if (excludeParts.some((part) => rel.includes(`/${part}/`) || rel.includes(`${part}/`))) continue;
      let st;
      try {
        st = fs.statSync(f.fullPath);
      } catch {
        continue;
      }
      const mtimeDate = localDateString(st.mtime);
      if (mtimeDate < since || mtimeDate > until) continue;
      out.push({ relPath: rel, fullPath: f.fullPath, mtimeDate, size: st.size, dirPriority: i });
    }
  }

  return out.sort(
    (a, b) =>
      a.dirPriority - b.dirPriority ||
      b.mtimeDate.localeCompare(a.mtimeDate) ||
      a.relPath.localeCompare(b.relPath)
  );
}

/** @param {string} content */
export function sha256Text(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * @param {string} text
 * @param {number} maxChars
 */
export function truncateText(text, maxChars) {
  if (text.length <= maxChars) {
    return { text, truncated: false, originalChars: text.length, keptChars: text.length };
  }
  const suffix = `\n\n[... truncado: ${text.length - maxChars} caracteres omitidos ...]`;
  const kept = Math.max(0, maxChars - suffix.length);
  return {
    text: text.slice(0, kept) + suffix,
    truncated: true,
    originalChars: text.length,
    keptChars: kept
  };
}

/**
 * @param {string} name
 * @param {unknown} data
 * @param {{ error?: string, metadata?: Record<string, unknown> }} [extra]
 */
export function sourceOk(name, data, extra = {}) {
  const empty =
    data == null ||
    (Array.isArray(data) && data.length === 0) ||
    (typeof data === "object" && !Array.isArray(data) && Object.keys(data).length === 0);
  return {
    source: name,
    status: /** @type {SourceStatus} */ (empty ? "empty" : "ok"),
    data: data ?? null,
    error: extra.error ?? null,
    metadata: extra.metadata ?? {}
  };
}

/** @param {string} name @param {string} message @param {Record<string, unknown>} [metadata] */
export function sourceError(name, message, metadata = {}) {
  return {
    source: name,
    status: /** @type {SourceStatus} */ ("error"),
    data: null,
    error: message,
    metadata
  };
}

/**
 * @param {Record<string, { status: SourceStatus, error?: string | null, metadata?: Record<string, unknown> }>} sections
 */
export function buildContextManifest(sections) {
  const sources = Object.entries(sections).map(([key, val]) => ({
    source: key,
    status: val.status,
    error: val.error ?? null,
    ...(val.metadata || {})
  }));
  const errors = sources.filter((s) => s.status === "error");
  const empty = sources.filter((s) => s.status === "empty");
  return {
    source_count: sources.length,
    ok: sources.filter((s) => s.status === "ok").length,
    empty: empty.length,
    errors: errors.length,
    sources,
    error_details: errors.map((s) => ({ source: s.source, error: s.error }))
  };
}

/** Rough token estimate (chars / 4). */
export function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

/**
 * @param {number} promptTokens
 * @param {number} completionTokens
 * @param {string} model
 * @param {{ inputPerMillion?: number, outputPerMillion?: number, cachedTokens?: number, cacheWriteTokens?: number }} [overrides]
 */
export function estimateCostUsd(promptTokens, completionTokens, model, overrides = {}) {
  const defaults = {
    "gpt-5.6-luna": { miss: 0.2, hit: 0.02, out: 1.2, write: 0.25 },
    "gpt-5.6-terra": { miss: 2.0, hit: 0.2, out: 12.0, write: 2.5 },
    "gpt-4o-mini": { miss: 0.15, hit: 0.075, out: 0.6, write: null },
    "deepseek-chat": { miss: 0.14, hit: 0.014, out: 0.28, write: null },
    "deepseek-flash": { miss: 0.15, hit: 0.003, out: 0.6, write: null },
    "deepseek-v4-flash": { miss: 0.15, hit: 0.003, out: 0.6, write: null },
    "deepseek-v4-pro": { miss: 0.66, hit: 0.022, out: 1.98, write: null }
  };
  const rates = defaults[model] || { miss: 1.0, hit: 0.5, out: 4.0, write: null };
  const inputRate = overrides.inputPerMillion ?? rates.miss;
  const outputRate = overrides.outputPerMillion ?? rates.out;
  const cached = overrides.cachedTokens ?? 0;
  const cacheWrite = overrides.cacheWriteTokens ?? 0;
  const miss = Math.max(0, promptTokens - cached);
  const written = rates.write != null ? cacheWrite : 0;
  const plain = Math.max(0, miss - written);
  const hitRate = rates.hit ?? inputRate * 0.5;
  const writeRate = rates.write ?? inputRate;
  const cost =
    (plain / 1_000_000) * inputRate +
    (cached / 1_000_000) * hitRate +
    (written / 1_000_000) * writeRate +
    (completionTokens / 1_000_000) * outputRate;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** @param {string} month YYYY-MM @param {string} body */
export function buildOutputMarkdown(month, body) {
  const today = new Date().toISOString().slice(0, 10);
  return `---
date: ${today}
month: ${month}
---

${body.trim()}
`;
}

/** @param {Array<{ document_date?: string | null, document_type?: string, source?: string }>} docs @param {string} month */
export function filterDocumentsForMonth(docs, month) {
  return docs.filter((d) => d.document_date === month);
}

/**
 * @param {Array<{ document_date?: string | null, document_type?: string, source?: string }>} docs
 * @param {string} documentType
 * @param {string} month
 */
export function findPreviousDocument(docs, documentType, month) {
  const sameType = docs
    .filter((d) => d.document_type === documentType && d.document_date && d.document_date < month)
    .sort((a, b) => String(b.document_date).localeCompare(String(a.document_date)));
  return sameType[0] || null;
}

/**
 * Extrae las posiciones vivas del portfolio.md (tablas de acciones, ETFs y crypto).
 * Sustituye al recorte a 8.000 chars del documento entero, que dejaba fuera
 * las filas de la mitad inferior de la tabla (ZZZT, ZZZU y los ETFs).
 * Las filas tachadas (~~SMCI~~) son posiciones vendidas y se omiten.
 *
 * @param {string | null | undefined} markdown
 * @returns {{ ticker: string | null, name: string, isin: string | null, kind: "stock" | "etf" | "crypto", note: string }[]}
 */
export function extractPortfolioHoldings(markdown) {
  if (!markdown) return [];
  const lines = markdown.split(/\r?\n/);
  const holdings = [];
  const seen = new Set();
  const clean = (s) =>
    s
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
      .replace(/\[\[([^\]]+)\]\]/g, "$1")
      .replace(/\*\*|__|`/g, "")
      .replace(/\s+/g, " ")
      .trim();
  // Los "|" dentro de [[enlace|alias]] o escapados como "\|" no separan celdas.
  const PIPE = "\u0000";
  const cells = (line) =>
    line
      .trim()
      .replace(/\[\[[^\]]*\]\]/g, (m) => m.replace(/\\?\|/g, PIPE))
      .replace(/\\\|/g, PIPE)
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.replaceAll(PIPE, "|").trim());

  let kind = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("|")) {
      kind = null;
      continue;
    }
    if (kind === null) {
      const header = cells(line).map((c) => c.toLowerCase());
      const next = lines[i + 1] || "";
      if (!/^\s*\|?\s*:?-{3,}/.test(next)) continue;
      if (header[0] === "ticker") kind = "stock";
      else if (header[0] === "etf") kind = "etf";
      else if (header[0] === "valor" && header.some((h) => h.includes("activos"))) kind = "crypto";
      else kind = "skip";
      i++; // separador
      continue;
    }
    if (kind === "skip") continue;
    const row = cells(line);
    if (!row[0] || row[0].startsWith("~~")) continue;
    const first = clean(row[0]);
    const isinCell = kind === "crypto" ? null : clean(row[1] || "");
    const isin = isinCell && /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isinCell) ? isinCell : null;
    const noteRaw = kind === "crypto" ? "" : clean(row[row.length - 1] || "");
    const note = noteRaw.length > 90 ? `${noteRaw.slice(0, 87)}…` : noteRaw;
    let ticker = null;
    let name = first;
    if (kind === "stock") {
      ticker = first;
      const m = noteRaw.match(/^([^,.(]+)/);
      name = m ? m[1].trim() : first;
    }
    const key = `${kind}:${ticker || name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    holdings.push({ ticker, name, isin, kind, note });
  }
  return holdings;
}

/** @param {ReturnType<typeof extractPortfolioHoldings>} holdings */
export function formatHoldingsForSearch(holdings) {
  const label = { stock: "Acción", etf: "ETF", crypto: "Crypto" };
  return holdings
    .map((h) => {
      const head = h.ticker || h.name;
      return `- ${label[h.kind]}: ${head}${h.note && h.note !== head ? ` — ${h.note}` : ""}`;
    })
    .join("\n");
}

/** Días completos entre una fecha YYYY-MM-DD y `now`. */
export function daysSince(dateYmd, now = new Date()) {
  const d = new Date(`${dateYmd}T00:00:00Z`);
  return Math.floor((now.getTime() - d.getTime()) / 86_400_000);
}
