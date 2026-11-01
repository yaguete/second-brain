#!/usr/bin/env node

/**
 * Sintetiza cambios del vault hacia la wiki (📒 Wiki) vía API compatible con OpenAI Chat Completions.
 *
 * Uso:
 *   npm run synthesize:wiki
 *   npm run synthesize:wiki -- --file "🗓️ Daily notes/2026.05.03.md"
 *
 * Env:
 *   OBSIDIAN_VAULT_PATH (obligatoria; no hay ruta por defecto)
 *   VAULT_STATE_FILE (opcional) — ver scripts/lib/vault-bridge-state.js; por defecto
 *     `<vault>/.canonical-wiki-vault-state.json` (iCloud con el vault).
 *   BRAIN_WIKI_DIR_NAME (default: "📒 Wiki")
 *   OPENAI_API_KEY — por defecto (OpenAI)
 *   WIKI_SYNTHESIS_MODEL — modelo (default: gpt-5.6-luna); ej. deepseek-flash, deepseek-v4-pro
 *   WIKI_SYNTHESIS_BASE_URL — opcional; ej. https://api.deepseek.com (si el nombre del modelo
 *     empieza por "deepseek" y no defines URL, se usa https://api.deepseek.com)
 *   WIKI_SYNTHESIS_API_KEY — opcional; si existe, sustituye a las claves de abajo para este script
 *   DEEPSEEK_API_KEY — usada cuando la base URL es deepseek.com (o modelo deepseek-* sin URL explícita)
 *   WIKI_THINKING_STEPS — pasos con thinking (default: analysis); vacío = off
 *   WIKI_THINKING_EFFORT — low|high solo en modelos flash
 *   WIKI_LLM_TIMEOUT_MS — timeout por llamada (default 900000)
 *   WIKI_LLM_SDK_RETRIES — reintentos de red del SDK (default 3)
 *   WIKI_PROMPT_LAYOUT — legacy para desactivar prefijo estable
 *   WIKI_PROMPT_LAYOUT_STEPS — pasos con layout estable (default: source,create)
 *   WIKI_INDEX_MODE — compact|full (default compact)
 *   WIKI_CONTEXT_MAX_CHARS — cap de contextBlock (default 80000)
 *   WIKI_MIN_FACT_RETENTION — guard de hechos: por debajo NO se escribe la página (default 0.9; 0 = off)
 *   WIKI_ALERT_FACT_RETENTION — por debajo de esta retención el guard pasa a fallo duro:
 *     bloquea checkpoint y escribe aviso en el inbox (default 0.5). Entre este umbral y
 *     WIKI_MIN_FACT_RETENTION el trip es "soft": warn en consola, sin aviso ni bloqueo.
 *   WIKI_PAGE_SPLIT_WARN_CHARS — umbral para update quirúrgico (default 25000): el LLM
 *     parchea una sola sección `##` en vez de reescribir la página entera.
 *   WIKI_SURGICAL_SECTION_MAX_CHARS — chars de secciones de contexto en el parche (default 12000)
 *   DEEPSEEK_ALLOW_PEAK=1 — silencia aviso de horario pico
 *
 * Opciones:
 *   --dry-run                    No llama API ni escribe ficheros; muestra plan aproximado
 *   --analysis-only              Solo paso 1 (JSON plan), sin escribir wiki
 *   --file <rel>                 Procesa una o más rutas relativas al vault (repetible)
 *   --page <filename>            Con --file: solo actualiza esas páginas wiki (repetible); no crea
 *                                páginas ni reescribe la source page si ya existe
 *   --include-low-significance   Incluye fuentes con cambio normalizado bajo el umbral (por defecto se omiten)
 *
 * Exclusiones deterministas (sin LLM):
 *   - Rutas bajo la wiki y 🛠️ Resources/. 📥 Inbox/ sí se sintetiza.
 *   - Fuentes no-daily con tamaño UTF-8 < 200 bytes
 *   - Daily notes con menos de ~50 caracteres útiles tras quitar la plantilla fija
 *     (incluye tareas `- [ ]` no hechas; `[x]` / `[<]` sí cuentan)
 *   - Movimientos con hash idéntico (rename o cambio de carpeta) desde una ruta que ya
 *     era fuente sintetizable: el snapshot adopta la ruta nueva, sin LLM. Si el origen
 *     estaba excluido (p. ej. 🛠️ Resources/) o tenía aviso pendiente, se sintetiza.
 */

import { excludedPrefixes, includedPrefixes, requireVaultPath, wikiDirName } from "./lib/layout.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import OpenAI from "openai";
import {
  computeVaultDiff,
  walkMarkdownFiles,
  sha256,
  readFileSafe,
  normalizeContent,
  normalizedFingerprint,
  normalizePathKey,
  buildNextVaultFiles
} from "./lib/vault-diff.js";
import {
  buildWikiIndexMarkdown,
  buildWikiCompactIndex,
  buildWikiTitleIndex,
  normForCompare,
  parseFrontmatter
} from "./lib/brain-wiki.js";
import { extractDateFromFilename, normalizeDocumentDate, todayUtc } from "../bridge/src/shared/brain-date.js";
import { stripBinaryBlobs } from "../bridge/src/shared/utils.js";
import { recordUsage } from "../bridge/src/shared/llm-usage.js";
import {
  vaultStatePaths,
  wikiAlertsStatePaths,
  loadJsonState,
  saveJsonState
} from "./lib/vault-bridge-state.js";
import {
  detectSuspiciousCreate,
  detectSuspiciousUpdate,
  detectOversizedPage
} from "./lib/wiki-update-guard.js";
import {
  parseMarkdownSections,
  applySectionPatch,
  selectSectionsForPrompt,
  sectionOutline,
  countH2,
  findSectionIndex
} from "./lib/wiki-sections.js";
import { archiveDatedSnapshots } from "./lib/wiki-snapshot-archive.js";
import {
  archiveOldOneOnOnes,
  normalizeOneOnOneHeadings,
  oneOnOnePageSkeleton,
  oneOnOnePages,
  oneOnOneUpdateReason,
  parseOneOnOneSource
} from "./lib/wiki-one-on-ones.js";
import {
  emptyAlertState,
  normalizeAlertState,
  mergePendingAlerts,
  alertFilePaths,
  cleanupLegacyAlertFiles,
  syncAlertFile,
  pendingAlertPaths
} from "./lib/wiki-alerts.js";
import { classifySourceDoc } from "./lib/wiki-source-classify.js";
import { buildExtractiveSourcePage } from "./lib/wiki-extractive-source.js";
import { shouldSkipContent } from "./lib/wiki-daily-skip.js";
import { factRetention } from "./lib/wiki-fact-retention.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const VAULT_ROOT = requireVaultPath();
const { canonical: VAULT_STATE_FILE, legacy: VAULT_STATE_LEGACY } = vaultStatePaths(
  VAULT_ROOT,
  REPO_ROOT
);
const { canonical: WIKI_ALERTS_STATE_FILE } = wikiAlertsStatePaths(VAULT_ROOT);
const WIKI_DIR_NAME = wikiDirName();
const WIKI_PREFIX = `${WIKI_DIR_NAME}/`;
const EXCLUDED_PATH_PREFIXES = excludedPrefixes(WIKI_DIR_NAME);
const INCLUDED_PATH_PREFIXES = includedPrefixes();

/** Rutas exactas (relativas al vault) que no se sintetizan como fuente. */
const EXCLUDED_EXACT_PATHS = new Set(["CLAUDE.md"]);

const MODEL = process.env.WIKI_SYNTHESIS_MODEL || "gpt-5.6-luna";

const DEFAULT_DEEPSEEK_BASE = "https://api.deepseek.com";

/**
 * Cliente OpenAI SDK con otro proveedor (DeepSeek, etc.): mismo contrato chat.completions.
 * @returns {{ apiKey: string, baseURL: string | undefined }}
 */
function resolveWikiSynthesisAuth() {
  let baseURL = process.env.WIKI_SYNTHESIS_BASE_URL?.trim() || undefined;
  if (!baseURL && /^deepseek/i.test(MODEL)) {
    baseURL = DEFAULT_DEEPSEEK_BASE;
  }
  const deepseekHost = Boolean(baseURL && /deepseek\.com/i.test(baseURL));

  let apiKey = process.env.WIKI_SYNTHESIS_API_KEY?.trim();
  if (!apiKey) {
    apiKey = deepseekHost
      ? process.env.DEEPSEEK_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim()
      : process.env.OPENAI_API_KEY?.trim() || process.env.DEEPSEEK_API_KEY?.trim();
  }

  return { apiKey: apiKey || "", baseURL };
}
const DRY = process.argv.includes("--dry-run");
const ANALYSIS_ONLY = process.argv.includes("--analysis-only");
const INCLUDE_LOW_SIGNIFICANCE = process.argv.includes("--include-low-significance");
const SKIP_INGEST = process.argv.includes("--skip-ingest") || process.env.SYNC_WIKI === "1";
const MAX_PLAN_ENTRIES = 12;
/** Todas las apariciones de `--<flag> <valor>` (orden de argv). */
function repeatedArg(flag) {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === flag && process.argv[i + 1]) {
      out.push(process.argv[i + 1]);
      i++;
    }
  }
  return out;
}
const FILE_ARGS = repeatedArg("--file");
const FILE_ARG = FILE_ARGS.length > 0;
/** `--page <filename>`: con --file, solo actualiza esas páginas (re-aplicar updates omitidos). */
const PAGE_ARGS = repeatedArg("--page").map((p) => path.basename(p));

function loadVaultRules() {
  const claudeMdPath = path.join(VAULT_ROOT, "CLAUDE.md");
  if (!fs.existsSync(claudeMdPath)) {
    console.error(`CLAUDE.md no encontrado en ${claudeMdPath}`);
    process.exit(1);
  }
  return fs.readFileSync(claudeMdPath, "utf8");
}

const SYSTEM_SUFFIX = `

Responde SIEMPRE en el formato pedido en la INSTRUCCIÓN final del mensaje de usuario.
Contratos de salida posibles:
- ANALISIS  → JSON { source_page, pages_to_update, pages_to_create, files_to_read }
- PÁGINA    → JSON { "markdown": "..." } con frontmatter YAML completo y válido
Trabaja ÚNICAMENTE sobre la INSTRUCCIÓN que aparece al final del mensaje de usuario.`;

/** Solo el paso ANALISIS. No cambia source/update/create. */
const ANALYSIS_DAILY_TASK_HINT =
  "Si FICHERO_FUENTE es una daily: las tareas `- [ ]` (no hechas) son agenda, no hechos ocurridos — no las narres en pretérito ni actualices entidades como si hubieran pasado. `[x]` y `[<]` sí cuentan (hecho / reagendado). El «a fecha de» del estado actual es hoy, no la fecha del fichero si esta es futura.";

const SOURCE_MAX_CHARS = Number(process.env.WIKI_SOURCE_MAX_CHARS || 100_000);
const EXISTING_PAGE_MAX_CHARS = Number(process.env.WIKI_EXISTING_PAGE_MAX_CHARS || 100_000);
const PAGE_SPLIT_WARN_CHARS = Number(process.env.WIKI_PAGE_SPLIT_WARN_CHARS || 25_000);
const SURGICAL_SECTION_MAX_CHARS = Number(process.env.WIKI_SURGICAL_SECTION_MAX_CHARS || 12_000);
const CONTEXT_MAX_CHARS = Number(process.env.WIKI_CONTEXT_MAX_CHARS || 80_000);
const REPAIRABLE_STEPS = new Set(["analysis"]);
const USE_LEGACY_PROMPT = process.env.WIKI_PROMPT_LAYOUT === "legacy";
const LAYOUT_STEPS = new Set(
  (process.env.WIKI_PROMPT_LAYOUT_STEPS || "source,create")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
// `update` en páginas > WIKI_PAGE_SPLIT_WARN_CHARS usa parche de una sección
// (surgical); el rewrite entero se reserva para páginas pequeñas.
const THINK_STEPS = new Set(
  (process.env.WIKI_THINKING_STEPS ?? "analysis").split(",").map((s) => s.trim()).filter(Boolean)
);
const THINK_EFFORT = process.env.WIKI_THINKING_EFFORT || null;

function loadState() {
  const { data } = loadJsonState(VAULT_STATE_FILE, VAULT_STATE_LEGACY, () => ({ files: {} }));
  const obj = data && typeof data === "object" ? data : {};
  return obj.files ? obj : { files: {} };
}

function wikiPath(...parts) {
  return path.join(VAULT_ROOT, WIKI_DIR_NAME, ...parts);
}

function typeToSubdir(t) {
  const x = String(t || "").toLowerCase();
  if (x === "entity") return "entities";
  if (x === "concept") return "concepts";
  if (x === "synthesis") return "synthesis";
  return "sources";
}

/** LLM may return vault-relative paths; wikiPath() only accepts bare filenames. */
function sanitizeWikiFilename(raw, label = "filename") {
  if (!raw) return null;
  const fn = path.basename(String(raw).split("/").join(path.sep));
  if (fn !== raw) {
    console.warn(`  ${label} sanitizado: "${raw}" → "${fn}"`);
  }
  return fn || null;
}

/**
 * Extracts `title` from YAML frontmatter in a markdown string.
 * Returns null if not found.
 */
function extractFrontmatterTitle(md) {
  if (!md.startsWith("---")) return null;
  const end = md.indexOf("\n---", 3);
  if (end === -1) return null;
  const fm = md.slice(3, end);
  const match = fm.match(/^title:\s*"?(.+?)"?\s*$/m);
  return match ? match[1].trim() : null;
}

/**
 * Derives the expected title hint from a wiki filename.
 * "entity-sam-okafor.md" → "sam okafor"
 * "concept-permits-module.md" → "permits module"
 */
function titleHintFromFilename(filename) {
  return normForCompare(
    filename
      .replace(/\.md$/i, "")
      .replace(/^(entity|concept|source|synthesis)-/, "")
  );
}

/**
 * Checks whether `actualTitle` is consistent with `expectedTitle`.
 * Both are compared in normalized form; we check substring inclusion
 * in both directions to tolerate partial matches.
 */
function titlesMatch(actualTitle, expectedTitle) {
  const a = normForCompare(actualTitle);
  const b = normForCompare(expectedTitle);
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const aWords = new Set(a.split(" ").filter(Boolean));
  const bWords = new Set(b.split(" ").filter(Boolean));
  const common = [...aWords].filter((w) => bWords.has(w));
  return common.length >= Math.min(aWords.size, bWords.size) * 0.5;
}

function readUtf8(p) {
  return fs.readFileSync(p, "utf8");
}

function buildVaultFileTree() {
  // La wiki ya va en INDICE_WIKI_ACTUAL; listarla aquí es duplicación pura.
  // Escape: WIKI_TREE_INCLUDE_WIKI=1
  const includeWiki = process.env.WIKI_TREE_INCLUDE_WIKI === "1";
  return walkMarkdownFiles(VAULT_ROOT)
    .map((f) => f.relPath)
    .filter((rel) => includeWiki || !rel.startsWith(WIKI_PREFIX))
    .sort()
    .join("\n");
}

function readVaultFile(relPath) {
  const full = path.join(VAULT_ROOT, String(relPath || "").normalize("NFC"));
  if (!fs.existsSync(full)) {
    // macOS may store the on-disk form as NFD; try that before giving up.
    const nfd = path.join(VAULT_ROOT, String(relPath || "").normalize("NFD"));
    if (nfd !== full && fs.existsSync(nfd)) {
      try {
        return fs.readFileSync(nfd, "utf8");
      } catch {
        return null;
      }
    }
    return null;
  }
  try {
    return fs.readFileSync(full, "utf8");
  } catch {
    return null;
  }
}

function readRequestedFiles(relPaths, maxTotalChars = CONTEXT_MAX_CHARS) {
  const sections = [];
  let totalChars = 0;
  const perFileCap = Math.max(4_000, Math.floor(maxTotalChars / Math.max(1, relPaths.length)));
  let truncatedFiles = 0;
  for (const rel of relPaths) {
    const content = readVaultFile(rel);
    if (!content) continue;
    const { text: clean } = stripBinaryBlobs(content);
    let body = clean;
    if (body.length > perFileCap) {
      body = body.slice(0, perFileCap);
      truncatedFiles++;
    }
    const chunk = `--- ${rel} ---\n${body}`;
    if (totalChars + chunk.length > maxTotalChars) {
      console.warn(
        `  ⚠ contextBlock truncado: presupuesto ${maxTotalChars} chars (WIKI_CONTEXT_MAX_CHARS); ` +
          `ficheros individuales truncados=${truncatedFiles}`
      );
      break;
    }
    sections.push(chunk);
    totalChars += chunk.length;
  }
  if (truncatedFiles > 0 && sections.length > 0) {
    console.warn(`  ⚠ ${truncatedFiles} fichero(s) de contexto truncados individualmente`);
  }
  return sections.join("\n\n");
}

function writeUtf8(p, content) {
  if (process.env.WIKI_BACKUP_DIR && fs.existsSync(p)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(process.env.WIKI_BACKUP_DIR, `${stamp}__${path.basename(p)}`);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(p, dest);
    } catch {
      /* best-effort */
    }
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

function dirNameToType(dirName) {
  const map = {
    entities: "entity",
    concepts: "concept",
    synthesis: "synthesis",
    sources: "source",
    essays: "essay"
  };
  return map[dirName] || "source";
}
/** Hub wiki de la persona: `entity-<slug>` si existe; si no, por título; si no, el slug. */
function resolvePersonHub(persona, wikiIndex) {
  const { hub } = oneOnOnePages(persona);
  if (fs.existsSync(wikiPath("entities", `${hub}.md`))) return hub;
  const hit = (wikiIndex.byTitle.get(normForCompare(persona)) || []).find((f) => f.startsWith("entity-"));
  return hit ? hit.replace(/\.md$/, "") : hub;
}

/** Fuente de 1:1: la página `<hub>-1-1s.md` de la persona siempre se actualiza con la entrada. */
function withOneOnOnePage(plan, oneOnOne, pageFn) {
  const sourceFn = sanitizeWikiFilename(plan.source_page?.filename, "source_page.filename");
  const entry = { filename: pageFn, reason: oneOnOneUpdateReason(oneOnOne, sourceFn) };
  const others = (Array.isArray(plan.pages_to_update) ? plan.pages_to_update : []).filter(
    (u) => path.basename(String(u.filename || "")) !== pageFn
  );
  const creates = (Array.isArray(plan.pages_to_create) ? plan.pages_to_create : []).filter(
    (c) => path.basename(String(c.filename || "")) !== pageFn
  );
  return { ...plan, pages_to_update: [entry, ...others], pages_to_create: creates };
}

/** Con --page: solo esas páginas como updates (motivo genérico si el análisis no las propuso). */
function restrictPlanToPages(plan, pages) {
  const proposed = Array.isArray(plan.pages_to_update) ? plan.pages_to_update : [];
  const updates = pages.map(
    (fn) =>
      proposed.find((u) => path.basename(String(u.filename || "")) === fn) || {
        filename: fn,
        reason: "Integrar lo que FICHERO_FUENTE aporta sobre esta página."
      }
  );
  return { ...plan, pages_to_update: updates, pages_to_create: [] };
}

function capPlan(plan) {
  const updates = Array.isArray(plan.pages_to_update) ? [...plan.pages_to_update] : [];
  const creates = Array.isArray(plan.pages_to_create) ? [...plan.pages_to_create] : [];
  const total = updates.length + creates.length;
  if (total <= MAX_PLAN_ENTRIES) {
    return { ...plan, pages_to_update: updates, pages_to_create: creates };
  }

  const maxUpdates = Math.min(updates.length, MAX_PLAN_ENTRIES);
  const remaining = MAX_PLAN_ENTRIES - maxUpdates;
  const trimmedUpdates = updates.slice(0, maxUpdates);
  const trimmedCreates = creates.slice(0, Math.max(0, remaining));
  console.warn(
    `Plan recortado de ${total} a ${trimmedUpdates.length + trimmedCreates.length} entradas (máx ${MAX_PLAN_ENTRIES}).`
  );
  return { ...plan, pages_to_update: trimmedUpdates, pages_to_create: trimmedCreates };
}

function dedupePlanCreates(plan, wikiIndex) {
  const creates = Array.isArray(plan.pages_to_create) ? plan.pages_to_create : [];
  const kept = [];
  for (const entry of creates) {
    const fn = sanitizeWikiFilename(entry.filename, "pages_to_create.filename");
    if (!fn) continue;
    if (wikiIndex.byFilename.has(fn)) {
      console.warn(`Create omitido (ya existe en wiki): ${fn}`);
      continue;
    }
    const titleHint = titleHintFromFilename(fn);
    const dupByTitle = wikiIndex.byTitle.get(normForCompare(titleHint));
    if (dupByTitle?.length) {
      console.warn(
        `Create omitido (título similar ya indexado): ${fn} ~ ${dupByTitle.join(", ")}`
      );
      continue;
    }
    kept.push(entry);
  }
  return { ...plan, pages_to_create: kept };
}

function upsertFrontmatterField(fmBlock, key, value) {
  const re = new RegExp(`^${key}:\\s*.+$`, "m");
  const line = `${key}: ${value}`;
  if (re.test(fmBlock)) return fmBlock.replace(re, line);
  return `${fmBlock.trim()}\n${line}`;
}

function yamlString(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function postprocessWikiMarkdown(md, { typeHint, titleHint, sourceVaultPath, eventDate } = {}) {
  if (!md.startsWith("---")) return md;
  const end = md.indexOf("\n---", 3);
  if (end === -1) return md;
  let fmBlock = md.slice(3, end);
  const body = md.slice(end + 4);

  const parsed = parseFrontmatter(md);
  const today = todayUtc();
  const created = normalizeDocumentDate(parsed.data.created, { maxDate: today }) || today;
  const updated = normalizeDocumentDate(parsed.data.updated, { fallback: created, maxDate: today }) || created;
  const title = parsed.data.title ? String(parsed.data.title) : titleHint || "Untitled";
  const type = parsed.data.type ? String(parsed.data.type) : typeHint || "source";

  fmBlock = upsertFrontmatterField(fmBlock, "title", yamlString(title));
  fmBlock = upsertFrontmatterField(fmBlock, "type", type);
  fmBlock = upsertFrontmatterField(fmBlock, "created", created);
  fmBlock = upsertFrontmatterField(fmBlock, "updated", updated);
  if (sourceVaultPath) {
    fmBlock = upsertFrontmatterField(fmBlock, "source_vault", yamlString(String(sourceVaultPath).normalize("NFC")));
  }
  if (eventDate) {
    fmBlock = upsertFrontmatterField(fmBlock, "event_date", eventDate);
  }

  return `---\n${fmBlock.trim()}\n---${body.startsWith("\n") ? "" : "\n"}${body}`;
}

const LLM_RETRIES = Number(process.env.WIKI_LLM_RETRIES || 2);
const LLM_RETRY_DELAY_MS = Number(process.env.WIKI_LLM_RETRY_DELAY_MS || 1500);
const LLM_TIMEOUT_MS = Number(process.env.WIKI_LLM_TIMEOUT_MS || 900_000);
const LLM_SDK_RETRIES = Number(process.env.WIKI_LLM_SDK_RETRIES || 3);
const LLM_MAX_TOKENS = Number(process.env.WIKI_LLM_MAX_TOKENS || 32_768);
// gpt-5 and o-series reject max_tokens; DeepSeek and gpt-4o still use it.
const TOKEN_LIMIT_FIELD = /^(gpt-5|o\d)/i.test(MODEL) ? "max_completion_tokens" : "max_tokens";
const TOKEN_LIMIT = /gpt-4o-mini/i.test(MODEL) ? Math.min(LLM_MAX_TOKENS, 16_384) : LLM_MAX_TOKENS;
const LLM_STREAM = process.env.WIKI_LLM_STREAM !== "off";

/**
 * Intenta parsear JSON; si falla, sanitiza escapes comunes de modelos
 * que no respetan JSON estricto y reintenta.
 */
function safeParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    // intentar extraer primer bloque {...} o ```json ... ```
  }
  let cleaned = raw;
  const fenced = raw.match(/```json\s*([\s\S]*?)```/);
  if (fenced) cleaned = fenced[1].trim();
  else {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last > first) cleaned = cleaned.slice(first, last + 1);
  }
  // fix invalid escape sequences (\_ \# \| \> \( \) etc.)
  cleaned = cleaned.replace(/\\([^"\\\/bfnrtu])/g, "$1");
  return JSON.parse(cleaned);
}

/** Aviso de horario pico DeepSeek: 09:00-12:00 y 14:00-18:00 UTC+8. */
function deepseekPeakWarning() {
  if (!/^deepseek/i.test(MODEL)) return;
  const beijingHour = (new Date().getUTCHours() + 8) % 24;
  const peak = (beijingHour >= 9 && beijingHour < 12) || (beijingHour >= 14 && beijingHour < 18);
  if (peak && process.env.DEEPSEEK_ALLOW_PEAK !== "1") {
    console.warn(
      `⚠ Horario PICO DeepSeek (${beijingHour}:00 UTC+8). Cuando la política 2x entre en vigor, ` +
        `este run costará el doble. Ventana barata en Madrid: 12:00–02:00. ` +
        `Usa DEEPSEEK_ALLOW_PEAK=1 para silenciar.`
    );
  }
}

/**
 * Bloque estable por fuente. Orden = volatilidad creciente:
 * tree (por run) → fuente (por fuente) → contexto (post-análisis).
 */
function buildStableHead({ vaultFileTree, rel, sourceSlice, contextBlock }) {
  let head = `FICHEROS DISPONIBLES EN EL VAULT (puedes pedir leer cualquiera):
${vaultFileTree}

FICHERO_FUENTE (ruta relativa al vault): ${rel}
CONTENIDO:
${sourceSlice}`;
  if (contextBlock) {
    head += `\n\nCONTEXTO ADICIONAL DEL VAULT (ficheros que pediste leer):\n${contextBlock}`;
  }
  return head;
}

function useStableLayout(step) {
  return !USE_LEGACY_PROMPT && LAYOUT_STEPS.has(step);
}

async function llmCall(client, system, user, step = "unknown") {
  const payload = {
    model: MODEL,
    response_format: { type: "json_object" },
    // Sin esto el proveedor aplica su default (8192 en DeepSeek) y las páginas grandes
    // vuelven troceadas: JSON truncado con "Unterminated string".
    [TOKEN_LIMIT_FIELD]: TOKEN_LIMIT,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  };

  if (/^deepseek/i.test(MODEL)) {
    const thinking = THINK_STEPS.has(step);
    payload.thinking = { type: thinking ? "enabled" : "disabled" };
    if (thinking && THINK_EFFORT && /flash/i.test(MODEL)) {
      payload.reasoning_effort = THINK_EFFORT;
    }
    if (!thinking) payload.temperature = 0.2;
  } else if (!/^(gpt-5|o\d)/i.test(MODEL)) {
    payload.temperature = 0.2;
  }

  const extra = { system_chars: system.length, user_chars: user.length };
  let content = "";
  let reasoningContent = "";
  let usage = null;
  let finishReason = null;

  if (LLM_STREAM) {
    // Una respuesta larga sin streaming deja el socket mudo varios minutos y el
    // proveedor lo cierra ("TypeError: terminated"). Los deltas lo mantienen vivo.
    const stream = await client.chat.completions.create({
      ...payload,
      stream: true,
      stream_options: { include_usage: true }
    });
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) content += choice.delta.content;
      if (choice?.delta?.reasoning_content) reasoningContent += choice.delta.reasoning_content;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
    }
  } else {
    const res = await client.chat.completions.create(payload);
    const choice = res.choices?.[0];
    content = choice?.message?.content || "";
    reasoningContent = choice?.message?.reasoning_content || "";
    finishReason = choice?.finish_reason || null;
    usage = res.usage;
  }

  recordUsage({
    step,
    model: MODEL,
    usage,
    message: reasoningContent ? { reasoning_content: reasoningContent } : null,
    extra
  });

  if (finishReason === "length") {
    throw new Error(
      `respuesta truncada por max_tokens (${LLM_MAX_TOKENS}) en el paso ${step}; ` +
        `sube WIKI_LLM_MAX_TOKENS o divide la página`
    );
  }

  return content || "{}";
}

function isNonRetryableLlmError(e) {
  const msg = String(e?.message || e || "");
  return /\bterminated\b|ECONNRESET|ERR_STREAM_PREMATURE_CLOSE|socket hang up/i.test(msg);
}

async function repairJson(client, brokenText, step) {
  if (process.env.WIKI_JSON_REPAIR === "off") {
    throw new Error("JSON repair disabled");
  }
  const res = await client.chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    [TOKEN_LIMIT_FIELD]: TOKEN_LIMIT,
    messages: [
      {
        role: "system",
        content: "Devuelves exclusivamente JSON válido. No añades comentarios ni fences."
      },
      {
        role: "user",
        content: `Corrige este texto para que sea JSON válido, preservando el contenido literal:\n\n${brokenText.slice(0, 60_000)}`
      }
    ]
  });
  recordUsage({
    step: `${step}:repair`,
    model: MODEL,
    usage: res.usage,
    message: res.choices?.[0]?.message
  });
  return res.choices?.[0]?.message?.content || "{}";
}

async function chatJson(client, system, user, step = "analysis") {
  let lastErr;
  let lastText = "";
  for (let attempt = 0; attempt <= LLM_RETRIES; attempt++) {
    try {
      let text;
      if (attempt === 1 && REPAIRABLE_STEPS.has(step) && lastText) {
        text = await repairJson(client, lastText, step);
      } else {
        text = await llmCall(client, system, user, step);
      }
      lastText = text;
      return safeParseJson(text);
    } catch (e) {
      lastErr = e;
      console.warn(
        `  JSON parse error (attempt ${attempt + 1}/${LLM_RETRIES + 1}): ${e.message.slice(0, 120)}`
      );
      if (isNonRetryableLlmError(e) || attempt >= LLM_RETRIES) break;
      console.warn(`  Retrying in ${LLM_RETRY_DELAY_MS / 1000}s...`);
      await new Promise((r) => setTimeout(r, LLM_RETRY_DELAY_MS));
    }
  }
  throw new Error(`JSON parse failed after ${LLM_RETRIES + 1} attempts: ${lastErr.message}`);
}

async function chatMarkdown(client, system, user, step = "source") {
  let lastErr;
  for (let attempt = 0; attempt <= LLM_RETRIES; attempt++) {
    try {
      const text = await llmCall(client, system, user, step);
      const obj = safeParseJson(text);
      if (typeof obj.markdown !== "string") throw new Error("Model response missing markdown field");
      return obj.markdown.trim();
    } catch (e) {
      lastErr = e;
      console.warn(
        `  Fallo en paso ${step} (attempt ${attempt + 1}/${LLM_RETRIES + 1}): ${e.message.slice(0, 120)}`
      );
      if (isNonRetryableLlmError(e) || attempt >= LLM_RETRIES) break;
      console.warn(`  Retrying in ${LLM_RETRY_DELAY_MS / 1000}s...`);
      await new Promise((r) => setTimeout(r, LLM_RETRY_DELAY_MS));
    }
  }
  throw new Error(`chatMarkdown failed after ${LLM_RETRIES + 1} attempts: ${lastErr.message}`);
}

function isPipelineAlert(relPath) {
  const base = relPath.split("/").pop();
  return base === "⚠ wiki-sync.md" || /^⚠ wiki-sync-\d{4}-\d{2}-\d{2}\.md$/.test(base);
}

function shouldProcessSource(relPath) {
  if (EXCLUDED_EXACT_PATHS.has(relPath) || isPipelineAlert(relPath)) return false;
  if (INCLUDED_PATH_PREFIXES.some((prefix) => relPath.startsWith(prefix))) return true;
  return !EXCLUDED_PATH_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

/**
 * Un movimiento con hash idéntico solo se salta si el origen ya pasaba por el LLM:
 * un origen excluido (p. ej. 🛠️ Resources/) todavía no ha pasado por el LLM.
 * @returns {string | null} motivo para sintetizar, o null si basta con adoptar la ruta
 */
function movedSourceNeedsSynthesis({ from, to }, pendingAlertSet) {
  if (pendingAlertSet.has(normalizePathKey(from))) return "origin_pending_alert";
  if (!shouldProcessSource(from)) return "origin_excluded";
  const content = readVaultFile(to);
  if (content != null && shouldSkipContent(from, content).skip) return "origin_skipped";
  return null;
}

/**
 * Quita frontmatter y líneas fijas de la plantilla Daily (habit tracker, secciones vacías, cierre).
 * @param {string} raw
 * @returns {string} texto útil colapsado para medir longitud
 */
function resolveFileArg(rawRel) {
  const rel = String(rawRel || "").split(path.sep).join("/").normalize("NFC");
  const full = path.join(VAULT_ROOT, rel);
  if (!fs.existsSync(full)) {
    const nfdFull = path.join(VAULT_ROOT, rel.normalize("NFD"));
    if (!(nfdFull !== full && fs.existsSync(nfdFull))) {
      console.error(`No existe: ${full}`);
      process.exit(1);
    }
  }
  if (!shouldProcessSource(rel)) {
    console.error(
      "La ruta está excluida (wiki, 🛠️ Resources/ o un aviso ⚠ wiki-sync); elige otra fuente."
    );
    process.exit(1);
  }
  return rel;
}

function resolveFileArgs() {
  const seen = new Set();
  const out = [];
  for (const raw of FILE_ARGS) {
    const rel = resolveFileArg(raw);
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

async function surgicalUpdatePage({
  client,
  systemBase,
  head,
  existing,
  reason,
  preferredSection,
  filename,
  keepHint = ""
}) {
  const parsed = parseMarkdownSections(existing);
  const outline = sectionOutline(parsed.sections) || "(sin secciones ##)";
  const picked = selectSectionsForPrompt(parsed.sections, reason, {
    maxChars: SURGICAL_SECTION_MAX_CHARS,
    maxSections: 3,
    preferredTitle: preferredSection
  });
  const pickedBlock =
    picked.length > 0
      ? picked.map((s) => s.body).join("\n\n----\n\n")
      : parsed.preamble.slice(0, SURGICAL_SECTION_MAX_CHARS);

  const instr =
    `INSTRUCCIÓN: la página ${filename} es demasiado grande para reescribirla entera.\n` +
    `NO devuelvas la página completa ni el frontmatter. Devuelve JSON:\n` +
    `{ "section": "<título exacto de un ## existente, o uno nuevo>", "markdown": "## título\\n\\ncuerpo completo de ESA sección" }\n\n` +
    `SECCIONES DE LA PÁGINA:\n${outline}\n\n` +
    `SECCIONES RELEVANTES (cuerpo actual):\n${pickedBlock}\n\n` +
    `Motivo del update: ${reason || ""}\n\n` +
    `Reglas:\n` +
    `- Cambia UNA sección (o crea una ## nueva si ninguna encaja; se inserta antes de Ver también).\n` +
    `- El markdown debe ser la sección COMPLETA (el ## y todo su contenido), no un diff.\n` +
    `- Conserva los hechos de esa sección; integra lo nuevo de FICHERO_FUENTE.\n` +
    `- PROHIBIDO marcadores tipo [sin cambios], [...], existing content unchanged.\n` +
    `- No toques el frontmatter ni las demás secciones.\n` +
    keepHint +
    `Trabaja ÚNICAMENTE sobre esta INSTRUCCIÓN.`;

  const patch = await chatJson(client, systemBase, `${head}\n\n${instr}`, "update");
  if (typeof patch.markdown !== "string" || !patch.markdown.trim()) {
    throw new Error("surgical update missing markdown");
  }
  const h2 = countH2(patch.markdown);
  if (h2 > 3) {
    throw new Error(`surgical update returned ${h2} ## headings; expected one section`);
  }

  const patched = applySectionPatch(existing, {
    section: patch.section,
    markdown: patch.markdown.trim()
  });

  const before = parseMarkdownSections(existing);
  const after = parseMarkdownSections(patched);
  const title = String(
    (String(patch.markdown).match(/^##\s+(.+)$/m) || [])[1] || patch.section || ""
  );
  const oldIdx = findSectionIndex(before.sections, title);
  const newIdx = findSectionIndex(after.sections, title);
  if (oldIdx >= 0 && newIdx >= 0) {
    const oldLen = before.sections[oldIdx].body.length;
    const newLen = after.sections[newIdx].body.length;
    if (oldLen > 800 && newLen < 0.2 * oldLen) {
      throw new Error(
        `surgical section shrink (${newLen} chars, ${Math.round((newLen / oldLen) * 100)}% of previous section)`
      );
    }
  }
  return patched;
}

function persistVaultSnapshot({ currentSnapshot, prevFiles, failedPaths = [], icloudPending = [] }) {
  if (!currentSnapshot) return;
  const files = buildNextVaultFiles({
    current: currentSnapshot,
    prevFiles,
    failedPaths,
    icloudPending
  });
  saveJsonState(VAULT_STATE_FILE, { last_run: new Date().toISOString(), files });
  const failedCount = [...failedPaths].length;
  console.log(
    `Vault state actualizado: ${VAULT_STATE_FILE} (excluidas ${failedCount} fallidas` +
      (icloudPending.length ? `, iCloud pending ${icloudPending.length}` : "") +
      `)`
  );
}

function loadPendingRetryPaths() {
  try {
    const { data } = loadJsonState(WIKI_ALERTS_STATE_FILE, WIKI_ALERTS_STATE_FILE, emptyAlertState);
    return pendingAlertPaths(data);
  } catch {
    return [];
  }
}

async function main() {
  const { apiKey, baseURL } = resolveWikiSynthesisAuth();
  if (!apiKey && !DRY) {
    console.error(
      "Clave API requerida para synthesize:wiki: OPENAI_API_KEY (OpenAI), o DEEPSEEK_API_KEY con WIKI_SYNTHESIS_BASE_URL=https://api.deepseek.com (o modelo deepseek-*), o WIKI_SYNTHESIS_API_KEY."
    );
    process.exit(1);
  }
  if (!fs.existsSync(VAULT_ROOT)) {
    console.error(`Vault no encontrado: ${VAULT_ROOT}`);
    process.exit(1);
  }

  if (!DRY) cleanupLegacyWikiAlerts();

  const client = DRY ? null : new OpenAI({
    apiKey,
    timeout: LLM_TIMEOUT_MS,
    maxRetries: LLM_SDK_RETRIES,
    ...(baseURL ? { baseURL } : {})
  });
  const VAULT_RULES = loadVaultRules();
  const SYSTEM_BASE = VAULT_RULES + SYSTEM_SUFFIX;

  const prevFiles = loadState().files || {};
  let currentSnapshot = null;
  let icloudPending = [];
  const orphanedAlertPaths = [];
  let targets;
  if (FILE_ARG) {
    targets = resolveFileArgs();
  } else {
    const diff = computeVaultDiff(VAULT_ROOT, prevFiles);
    currentSnapshot = diff.current;
    icloudPending = diff.icloudPending || [];
    console.log(
      `Vault diff: created=${diff.created.length} modified=${diff.modified.length}` +
        ` moved=${diff.moved.length} low_significance=${diff.lowSignificance.length}` +
        ` icloud_pending=${icloudPending.length}`
    );
    const pendingAlertPaths = loadPendingRetryPaths();
    const pendingAlertSet = new Set(pendingAlertPaths.map(normalizePathKey));
    const set = new Set([...diff.created, ...diff.modified]);
    for (const m of diff.moved) {
      const why = movedSourceNeedsSynthesis(m, pendingAlertSet);
      if (why) {
        set.add(m.to);
        console.log(`MOVED (${why}): ${m.from} -> ${m.to} — se sintetiza`);
      } else {
        console.log(`SKIP (moved): ${m.from} -> ${m.to} — mismo contenido, sin LLM`);
      }
    }
    if (INCLUDE_LOW_SIGNIFICANCE) {
      for (const p of diff.lowSignificance) set.add(p);
    }
    const candidatePaths = [...set];
    const excluded = candidatePaths.filter((p) => !shouldProcessSource(p));
    const wikiExcluded = excluded.filter((p) => p.startsWith(WIKI_PREFIX));
    const otherExcluded = excluded.filter((p) => !p.startsWith(WIKI_PREFIX));
    if (wikiExcluded.length > 0) {
      console.log(
        `SKIP (excluded_path): ${wikiExcluded.length} archivo(s) bajo ${WIKI_PREFIX.slice(0, -1)}`
      );
    }
    for (const p of otherExcluded) console.log(`SKIP (excluded_path): ${p}`);
    targets = candidatePaths.filter(shouldProcessSource);

    for (const p of diff.normalizedOnly.filter(shouldProcessSource)) {
      console.log(
        `SKIP (normalized_only): ${p} — hash bruto distinto, contenido normalizado igual (sin LLM)`
      );
    }
    if (!INCLUDE_LOW_SIGNIFICANCE) {
      for (const p of diff.lowSignificance.filter(shouldProcessSource)) {
        console.log(
          `SKIP (low_significance): ${p} — cambio normalizado pequeño (umbral); usa --include-low-significance`
        );
      }
    }
    for (const x of icloudPending) {
      console.log(`SKIP (icloud_pending): ${x.path} (${x.error}) — no se checkpointa si es nuevo`);
    }

    const retrySet = new Set(targets);
    for (const p of pendingAlertPaths) {
      const key = normalizePathKey(p);
      if (!currentSnapshot[key] && !icloudPending.some((x) => x.path === key)) {
        orphanedAlertPaths.push(p);
        console.log(`ALERT (resuelta): ${p} — la ruta ya no existe (movida o borrada)`);
        continue;
      }
      if (!shouldProcessSource(p) || retrySet.has(p)) continue;
      retrySet.add(p);
      console.log(`RETRY (wiki-alert): ${p}`);
    }
    targets = [...retrySet];
  }

  {
    const afterPath = targets;
    const next = [];
    for (const rel of afterPath) {
      const content = readVaultFile(rel);
      if (content == null) {
        console.log(`SKIP (unreadable): ${rel}`);
        continue;
      }
      const check = shouldSkipContent(rel, content);
      if (check.skip) {
        const extra = check.detail ? ` ${check.detail}` : "";
        console.log(`SKIP (${check.reason}): ${rel}${extra}`);
        continue;
      }
      next.push(rel);
    }
    targets = next;
  }

  if (targets.length === 0) {
    console.log("No hay fuentes nuevas/modificadas fuera de la wiki. Nada que sintetizar.");
    if (!FILE_ARG && !DRY && !ANALYSIS_ONLY && currentSnapshot) {
      persistVaultSnapshot({ currentSnapshot, prevFiles, failedPaths: [], icloudPending });
    }
    if (!DRY && !ANALYSIS_ONLY && orphanedAlertPaths.length > 0) {
      syncWikiAlerts(orphanedAlertPaths, []);
    }
    process.exit(0);
  }

  console.log(
    `LLM wiki: model=${MODEL}${baseURL ? ` baseURL=${baseURL}` : " (OpenAI)"}`
  );
  deepseekPeakWarning();
  console.log(
    `Thinking steps: ${[...THINK_STEPS].join(",") || "(none)"} | prompt layout: ${USE_LEGACY_PROMPT ? "legacy" : [...LAYOUT_STEPS].join(",")}`
  );
  console.log(`Fuentes a sintetizar (${targets.length}):`);
  targets.forEach((t, i) => console.log(`  ${String(i + 1).padStart(3)}. ${t}`));
  console.log("");

  const indexPath = wikiPath("index.md");
  const logPath = wikiPath("log.md");
  if (!fs.existsSync(indexPath)) {
    console.error(`Falta index.md en ${indexPath}`);
    process.exit(1);
  }

  console.log("Escaneando ficheros del vault...");
  const vaultFileTree = buildVaultFileTree();
  console.log(`Vault file tree: ${vaultFileTree.split("\n").length} ficheros .md\n`);

  const INDEX_MODE = process.env.WIKI_INDEX_MODE || "compact";
  const indexForPrompt =
    INDEX_MODE === "compact"
      ? buildWikiCompactIndex(VAULT_ROOT, WIKI_DIR_NAME)
      : (() => {
          const raw = readUtf8(indexPath);
          if (raw.length > 0.9 * 80_000) {
            console.warn(
              `⚠ index.md al ${((raw.length / 80_000) * 100).toFixed(0)}% del cap de 80.000 — ` +
                `se truncará y romperá el prefijo de caché`
            );
          }
          return raw.length <= 80_000 ? raw : raw.slice(0, raw.lastIndexOf("\n", 80_000));
        })();
  console.log(`Índice para prompt (${INDEX_MODE}): ${indexForPrompt.length.toLocaleString()} chars`);

  const failedSources = [];
  const guardTrips = [];
  const processedPaths = [];

  for (let ti = 0; ti < targets.length; ti++) {
    const rel = targets[ti];
    const recentLog = fs.existsSync(logPath) ? readUtf8(logPath).slice(-8_000) : "";
    const fullSource = path.join(VAULT_ROOT, rel);
    const rawSource = readUtf8(fullSource);
    const { text: sourceBody, removed: blobChars } = stripBinaryBlobs(rawSource);
    if (blobChars > 0) {
      console.warn(
        `  ⚠ Blobs binarios eliminados de ${rel}: ${blobChars.toLocaleString()} chars ` +
          `(${((blobChars / rawSource.length) * 100).toFixed(1)}% del fichero)`
      );
    }
    const sourceSlice = sourceBody.slice(0, SOURCE_MAX_CHARS);
    console.log(`\n=== [${ti + 1}/${targets.length}] Sintetizando: ${rel} ===`);

    if (DRY) {
      console.log("(dry-run: no API, no escritura)");
      continue;
    }

    const written = { updated: [], created: [], skipped: [] };
    processedPaths.push(rel);

    try {
    // ── Paso 1: Análisis ────────────────────────────────────────────────
    let planRaw;
    if (useStableLayout("analysis")) {
      const headAnalysis = buildStableHead({
        vaultFileTree,
        rel,
        sourceSlice,
        contextBlock: ""
      });
      const analysisTail = `INDICE_WIKI_ACTUAL:
${indexForPrompt}

OPERACIONES_RECIENTES (log.md, últimas entradas):
${recentLog}

INSTRUCCIÓN: ejecuta el paso ANALISIS de la operación INGEST sobre FICHERO_FUENTE.
Ten en cuenta las operaciones recientes para evitar updates redundantes.
${ANALYSIS_DAILY_TASK_HINT}
Devuelve JSON con forma:
{ "source_page": {"filename":"...","title":"..."}, "pages_to_update": [...], "pages_to_create": [...], "files_to_read": [...] }
- Usa SOLO el nombre del fichero (sin ruta/directorio), en minúsculas con guiones.
- Limita a lo esencial (máx ~12 entradas combinadas).
- Si el hub tiene páginas hijas (entity-foo-estado.md, -decisiones.md, -cronologia.md…), actualiza la hija que posee el subtema. El hub solo si cambia identidad o estado actual.
- pages_to_update[].section (opcional): título exacto del ## a tocar cuando la página es grande.
- files_to_read: NO incluyas la fuente principal ni index.md ni log.md.
Trabaja ÚNICAMENTE sobre esta INSTRUCCIÓN.`;
      planRaw = await chatJson(client, SYSTEM_BASE, `${headAnalysis}\n\n${analysisTail}`, "analysis");
    } else {
      const analysisUser = `FICHERO_FUENTE (ruta relativa al vault): ${rel}

CONTENIDO:
${sourceSlice}

INDICE_WIKI_ACTUAL:
${indexForPrompt}

OPERACIONES_RECIENTES (log.md, últimas entradas):
${recentLog}

FICHEROS DISPONIBLES EN EL VAULT (puedes pedir leer cualquiera):
${vaultFileTree}

Ten en cuenta las operaciones recientes para evitar updates redundantes a páginas que ya integran esta información.
${ANALYSIS_DAILY_TASK_HINT}

Devuelve JSON con forma:
{
  "source_page": { "filename": "source-....md", "title": "..." },
  "pages_to_update": [{ "filename": "entity-....md", "reason": "..." }],
  "pages_to_create": [{ "filename": "entity-....md", "type": "entity|concept|source|synthesis", "reason": "..." }],
  "files_to_read": ["ruta/relativa/al/vault.md", "otra/ruta.md"]
}
- Usa SOLO el nombre del fichero (sin ruta/directorio), en minúsculas con guiones.
- Limita a lo esencial (máx ~12 entradas combinadas en pages_to_update + pages_to_create).
- Si el hub tiene páginas hijas (entity-foo-estado.md, -decisiones.md, -cronologia.md…), actualiza la hija que posee el subtema. El hub solo si cambia identidad o estado actual.
- pages_to_update[].section (opcional): título exacto del ## a tocar cuando la página es grande.
- files_to_read: NO incluyas la fuente principal ni el index — ya los tienes.`;
      planRaw = await chatJson(
        client,
        SYSTEM_BASE + "\n\nEjecuta el paso ANALISIS de la operación INGEST.",
        analysisUser,
        "analysis"
      );
    }

    const wikiIndex = buildWikiTitleIndex(VAULT_ROOT, WIKI_DIR_NAME);
    let plan = dedupePlanCreates(capPlan(planRaw), wikiIndex);
    const oneOnOne = parseOneOnOneSource(rawSource);
    const oneOnOneHub = oneOnOne ? resolvePersonHub(oneOnOne.persona, wikiIndex) : null;
    if (oneOnOne) plan = withOneOnOnePage(plan, oneOnOne, `${oneOnOneHub}-1-1s.md`);
    if (PAGE_ARGS.length > 0) plan = restrictPlanToPages(plan, PAGE_ARGS);
    console.log("Plan:", JSON.stringify(plan, null, 2));
    if (ANALYSIS_ONLY) continue;
    if (oneOnOne && !fs.existsSync(wikiPath("entities", `${oneOnOneHub}-1-1s.md`))) {
      writeUtf8(
        wikiPath("entities", `${oneOnOneHub}-1-1s.md`),
        oneOnOnePageSkeleton({ persona: oneOnOne.persona, hub: oneOnOneHub, today: todayUtc() })
      );
      console.log(`Creada página de 1:1s: entities/${oneOnOneHub}-1-1s.md`);
    }

    const filesToRead = (Array.isArray(plan.files_to_read) ? plan.files_to_read : []).filter(
      (f) =>
        f &&
        f !== rel &&
        path.basename(f) !== "index.md" &&
        path.basename(f) !== "log.md"
    );
    let additionalContext = "";
    if (filesToRead.length > 0) {
      console.log(`Leyendo ${filesToRead.length} fichero(s) de contexto adicional...`);
      additionalContext = readRequestedFiles(filesToRead);
      if (additionalContext) {
        console.log(`  Contexto cargado: ${Math.round(additionalContext.length / 1024)}KB`);
      }
    }

    const sourceFilename = sanitizeWikiFilename(plan.source_page?.filename, "source_page.filename");
    const sourceTitle = plan.source_page?.title || rel;
    if (!sourceFilename) {
      console.error("Plan sin source_page.filename; se omite escritura.");
      failedSources.push({ path: rel, error: "missing source_page.filename" });
      continue;
    }
    const sourceEventDate = extractDateFromFilename(rel);
    const head = useStableLayout("source")
      ? buildStableHead({ vaultFileTree, rel, sourceSlice, contextBlock: additionalContext })
      : null;

    // ── Paso 2: Crear source page ───────────────────────────────────────
    const sourcePagePath = wikiPath("sources", sourceFilename);
    const existingSourcePage = fs.existsSync(sourcePagePath) ? readUtf8(sourcePagePath) : null;
    if (PAGE_ARGS.length > 0 && existingSourcePage) {
      console.log(`--page: se conserva ${path.relative(VAULT_ROOT, sourcePagePath)}`);
    } else {
      const classification = classifySourceDoc(rel, sourceBody, {
        existingSourcePage,
        titleIndex: wikiIndex.byTitle
      });
      let genSourceMd;
      if (classification.extractive) {
        console.log(
          `  Source extractiva (${classification.reason}): facts=${classification.metrics.facts ?? "?"} ` +
            `tbl%=${classification.metrics.tablePct ?? "?"} dated=${classification.metrics.datedHeadings ?? "?"}`
        );
        genSourceMd = buildExtractiveSourcePage({
          sourceRel: normalizePathKey(rel),
          sourceContent: sourceBody,
          filename: sourceFilename,
          title: sourceTitle,
          eventDate: sourceEventDate
        });
      } else {
        if (classification.reason.startsWith("existing_retention_ok")) {
          console.log(`  Source LLM (skip extractive: ${classification.reason})`);
        }
        genSourceMd = useStableLayout("source")
          ? await chatMarkdown(
              client,
              SYSTEM_BASE,
              `${head}\n\nINSTRUCCIÓN: genera UNA página wiki type=source en sources/${sourceFilename}. Título: ${sourceTitle}. Devuelve JSON { "markdown": "..." } con frontmatter YAML válido. Trabaja ÚNICAMENTE sobre esta INSTRUCCIÓN.`,
              "source"
            )
          : await chatMarkdown(
              client,
              SYSTEM_BASE + "\n\nGenera UNA página wiki type=source en sources/.",
              `Crea markdown completo para sources/${sourceFilename}. Título: ${sourceTitle}. Fuente vault: ${rel}. Contenido fuente:\n${sourceSlice}${additionalContext ? `\n\nCONTEXTO ADICIONAL DEL VAULT:\n${additionalContext}` : ""}\n\nDevuelve JSON { "markdown": "..." } con frontmatter YAML válido.`,
              "source"
            );
      }
      writeUtf8(
        sourcePagePath,
        postprocessWikiMarkdown(genSourceMd, {
          typeHint: "source",
          titleHint: sourceTitle,
          sourceVaultPath: normalizePathKey(rel),
          eventDate: sourceEventDate
        })
      );
      console.log("Escrito:", path.relative(VAULT_ROOT, sourcePagePath));
    }

    // ── Updates ─────────────────────────────────────────────────────────
    const updates = Array.isArray(plan.pages_to_update) ? plan.pages_to_update : [];
    for (const u of updates) {
      const fn = sanitizeWikiFilename(u.filename, "pages_to_update.filename");
      if (!fn) continue;
      const guessed = ["entities", "concepts", "synthesis", "sources"].find((d) =>
        fs.existsSync(wikiPath(d, fn))
      );
      if (!guessed) {
        console.warn("Update omitido (no existe):", fn);
        continue;
      }
      const existing = readUtf8(wikiPath(guessed, fn));
      const existingData = parseFrontmatter(existing).data;
      const existingTitle = extractFrontmatterTitle(existing);
      const sizeGuard = detectOversizedPage(existing, {
        hardCap: EXISTING_PAGE_MAX_CHARS,
        warnChars: PAGE_SPLIT_WARN_CHARS,
        pageLabel: `${guessed}/${fn}`
      });
      const useSurgical = sizeGuard.oversized || existing.length > PAGE_SPLIT_WARN_CHARS;
      if (useSurgical) {
        console.warn(
          `⚠ OVERSIZED — surgical section update for ${fn}: ${sizeGuard.reason || `${existing.length.toLocaleString()} chars`}`
        );
      }
      const updateInstr =
        `PÁGINA ACTUAL (${guessed}/${fn}):\n${existing.slice(0, EXISTING_PAGE_MAX_CHARS)}\n\n` +
        (u.reason ? `MOTIVO DEL UPDATE (cúmplelo): ${u.reason}\n\n` : "") +
        `INSTRUCCIÓN: actualiza esa página integrando FICHERO_FUENTE. Devuelve JSON { "markdown": "..." } con la página completa como documento autocontenido y sintetizado. Puedes reorganizar, condensar y reescribir el contenido existente para integrarlo con lo nuevo — la página resultante debe leerse como un documento coherente y actualizado, no como un log cronológico de actualizaciones. Toda información factual relevante (fechas, nombres, decisiones, cifras, relaciones) debe sobrevivir a la reescritura; el detalle de contexto ya está en las fuentes enlazadas. PROHIBIDO usar marcadores de omisión tipo diff: nunca escribas [sin cambios], [existing content unchanged], same as before, el resto queda igual, [...] ni equivalentes. Si algo se conserva, escríbelo íntegro. Frontmatter con updated: fecha ISO hoy. Trabaja ÚNICAMENTE sobre esta INSTRUCCIÓN.`;
      const runUpdate = async (keepHint = "") => {
        if (useSurgical) {
          return surgicalUpdatePage({
            client,
            systemBase: SYSTEM_BASE,
            head,
            existing,
            reason: u.reason || "",
            preferredSection: u.section || "",
            filename: fn,
            keepHint
          });
        }
        const instr = keepHint ? `${updateInstr}\n${keepHint}` : updateInstr;
        return useStableLayout("update")
          ? chatMarkdown(client, SYSTEM_BASE, `${head}\n\n${instr}`, "update")
          : chatMarkdown(
              client,
              SYSTEM_BASE +
                `\n\nActualiza página existente en ${guessed}/. Devuelve un documento wiki canónico re-sintetizado.`,
              `PÁGINA ACTUAL:\n${existing.slice(0, EXISTING_PAGE_MAX_CHARS)}\n\nNUEVA FUENTE (${rel}):\n${sourceSlice}${additionalContext ? `\n\nCONTEXTO ADICIONAL:\n${additionalContext}` : ""}\n\n${instr}`,
              "update"
            );
      };
      let merged;
      try {
        merged = await runUpdate();
      } catch (updateErr) {
        const reason = `LLM update failed: ${updateErr.message}`;
        console.warn(`⚠ ${reason} — update SKIPPED for ${fn}`);
        written.skipped.push({ page: fn, reason, severity: "hard" });
        guardTrips.push({ path: rel, page: fn, reason, severity: "hard" });
        continue;
      }
      const mergedTitle = extractFrontmatterTitle(merged);
      if (existingTitle && mergedTitle && !titlesMatch(mergedTitle, existingTitle)) {
        const reason = `TITLE MISMATCH expected≈"${existingTitle}" got="${mergedTitle}"`;
        console.warn(`⚠ TITLE MISMATCH — update SKIPPED for ${fn}: ${reason}`);
        written.skipped.push({ page: fn, reason, severity: "hard" });
        guardTrips.push({ path: rel, page: fn, reason, severity: "hard" });
        continue;
      }
      let updateGuard = detectSuspiciousUpdate(existing, merged, {
        titleIndex: wikiIndex.byTitle
      });
      // Pérdida de hechos: un reintento indicando al LLM qué hechos eliminó, en vez
      // de descartar el update (la info de la fuente se perdería tras el checkpoint).
      if (updateGuard.suspicious && updateGuard.reason?.startsWith("fact loss")) {
        const { lost } = factRetention(existing, merged, { titleIndex: wikiIndex.byTitle });
        console.warn(`↻ FACT-RETENTION — reintentando ${fn} (${lost.length} hechos perdidos)`);
        const keepHint =
          `- REINTENTO: tu versión anterior eliminó estos hechos de la página. Deben aparecer ` +
          `literalmente en el resultado (fechas, cifras, [[wikilinks]]): ` +
          `${lost.map((f) => (f.type === "wikilink" ? `[[${f.value}]]` : f.value)).join(" · ")}\n`;
        try {
          const retried = await runUpdate(keepHint);
          const retryGuard = detectSuspiciousUpdate(existing, retried, {
            titleIndex: wikiIndex.byTitle
          });
          const retriedTitle = extractFrontmatterTitle(retried);
          const titleOk = !existingTitle || !retriedTitle || titlesMatch(retriedTitle, existingTitle);
          if (titleOk) {
            merged = retried;
            updateGuard = retryGuard;
          }
        } catch (retryErr) {
          console.warn(`  reintento fallido para ${fn}: ${retryErr.message}`);
        }
      }
      if (updateGuard.suspicious) {
        const severity = updateGuard.severity === "soft" ? "soft" : "hard";
        const tag = severity === "soft" ? "⚠ FACT-RETENTION (soft)" : "⚠ PLACEHOLDER/SHRINK/FACTS";
        console.warn(
          `${tag} — update SKIPPED for ${fn}: ${updateGuard.reason}` +
            (severity === "soft"
              ? " Ajusta WIKI_MIN_FACT_RETENTION si la condensación es deliberada (no bloquea checkpoint)."
              : "")
        );
        written.skipped.push({ page: fn, reason: updateGuard.reason, severity });
        guardTrips.push({ path: rel, page: fn, reason: updateGuard.reason, severity });
        continue;
      }
      const archiveOpts = {
        dirPath: wikiPath(guessed),
        filename: fn,
        sourcePrefix: `${WIKI_DIR_NAME}/${guessed}`,
        today: todayUtc()
      };
      merged = archiveOldOneOnOnes(
        archiveDatedSnapshots(normalizeOneOnOneHeadings(merged, fn), archiveOpts),
        archiveOpts
      );
      writeUtf8(
        wikiPath(guessed, fn),
        postprocessWikiMarkdown(merged, {
          typeHint: dirNameToType(guessed),
          titleHint: existingTitle || undefined,
          sourceVaultPath: existingData.source_vault ? String(existingData.source_vault) : undefined,
          eventDate: existingData.event_date ? String(existingData.event_date) : undefined
        })
      );
      written.updated.push(fn);
      console.log("Actualizado:", path.relative(VAULT_ROOT, wikiPath(guessed, fn)));
    }

    // ── Creates ─────────────────────────────────────────────────────────
    const creates = Array.isArray(plan.pages_to_create) ? plan.pages_to_create : [];
    for (const c of creates) {
      const fn = sanitizeWikiFilename(c.filename, "pages_to_create.filename");
      const t = c.type || "entity";
      if (!fn) continue;
      const sub = typeToSubdir(t);
      const dest = wikiPath(sub, fn);
      if (fs.existsSync(dest)) {
        console.warn("Create omitido (ya existe):", fn);
        continue;
      }
      const createInstr = `INSTRUCCIÓN: crea página nueva type=${t} en ${sub}/${fn}. Motivo: ${c.reason || ""}. Devuelve JSON { "markdown": "..." } con frontmatter completo. Trabaja ÚNICAMENTE sobre esta INSTRUCCIÓN.`;
      let createdMd;
      try {
        createdMd = useStableLayout("create")
          ? await chatMarkdown(client, SYSTEM_BASE, `${head}\n\n${createInstr}`, "create")
          : await chatMarkdown(
              client,
              SYSTEM_BASE + `\n\nCrea página nueva type=${t} en ${sub}/.`,
              `Nueva página ${fn}. Motivo: ${c.reason || ""}. Fuente (${rel}):\n${sourceSlice}${additionalContext ? `\n\nCONTEXTO:\n${additionalContext}` : ""}\n\n${createInstr}`,
              "create"
            );
      } catch (createErr) {
        const reason = `LLM create failed: ${createErr.message}`;
        console.warn(`⚠ ${reason} — create SKIPPED for ${fn}`);
        written.skipped.push({ page: fn, reason, severity: "hard" });
        guardTrips.push({ path: rel, page: fn, reason, severity: "hard" });
        continue;
      }
      const createdTitle = extractFrontmatterTitle(createdMd);
      const filenameHint = titleHintFromFilename(fn);
      if (createdTitle && filenameHint && !titlesMatch(createdTitle, filenameHint)) {
        const reason = `TITLE MISMATCH filename≈"${filenameHint}" got="${createdTitle}"`;
        console.warn(`⚠ TITLE MISMATCH — create SKIPPED for ${fn}: ${reason}`);
        written.skipped.push({ page: fn, reason, severity: "hard" });
        guardTrips.push({ path: rel, page: fn, reason, severity: "hard" });
        continue;
      }
      const createGuard = detectSuspiciousCreate(createdMd);
      if (createGuard.suspicious) {
        console.warn(`⚠ PLACEHOLDER — create SKIPPED for ${fn}: ${createGuard.reason}`);
        written.skipped.push({ page: fn, reason: createGuard.reason, severity: "hard" });
        guardTrips.push({ path: rel, page: fn, reason: createGuard.reason, severity: "hard" });
        continue;
      }
      writeUtf8(
        dest,
        postprocessWikiMarkdown(createdMd, { typeHint: t, titleHint: filenameHint || undefined })
      );
      written.created.push(fn);
      console.log("Creado:", path.relative(VAULT_ROOT, dest));
    }

    // ── Index + Log determinista ───────────────────────────────────────
    const today = new Date().toISOString().slice(0, 10);
    writeUtf8(indexPath, buildWikiIndexMarkdown(VAULT_ROOT, WIKI_DIR_NAME));
    console.log("Reconstruido index.md (determinista)");

    let logContent = fs.existsSync(logPath) ? readUtf8(logPath) : "";
    // Formato compacto (estilo pre-2026-08-07): counts + summary corto.
    // El detalle de páginas/guards vive en consola; meterlo aquí hincha log.md
    // y el prompt de análisis (OPERACIONES_RECIENTES) sin aportar mucho.
    const hardSkips = written.skipped.filter((s) => s.severity === "hard");
    const softSkips = written.skipped.filter((s) => s.severity !== "hard");
    const skipNote =
      written.skipped.length > 0
        ? ` ${[
            hardSkips.length > 0 ? `${hardSkips.length} omitidas por guard duro` : null,
            softSkips.length > 0 ? `${softSkips.length} por fact-retention suave` : null
          ]
            .filter(Boolean)
            .join(", ")} (detalle en consola).`
        : "";
    const logEntry = [
      `## [${today}] ingest | ${sourceTitle}`,
      `Pages created: ${written.created.length}. Pages updated: ${written.updated.length}.`,
      `Summary: Procesada «${sourceTitle}».${skipNote}`
    ].join("\n");
    logContent += (logContent.endsWith("\n") ? "\n" : "\n\n") + logEntry + "\n";
    writeUtf8(logPath, logContent);
    console.log("Append log.md (determinista)");

    // Checkpoint solo si no hubo skips DUROS: un fact-loss suave no debe atascar la fuente.
    if (hardSkips.length > 0) {
      console.warn(
        `  ⚠ Fuente NO marcada como procesada: ${hardSkips.length} página(s) omitidas por guard duro`
      );
      failedSources.push({
        path: rel,
        error: `guard skipped: ${hardSkips.map((s) => `${s.page} (${s.reason})`).join("; ")}`,
        pages: hardSkips.map((s) => s.page)
      });
    } else {
      if (softSkips.length > 0) {
        console.warn(
          `  ⚠ ${softSkips.length} página(s) omitidas por fact-retention suave; la fuente sí hace checkpoint`
        );
      }
      let fileInfo = currentSnapshot?.[rel];
      if (!fileInfo) {
        const r = readFileSafe(path.join(VAULT_ROOT, rel));
        if (r.ok) {
          const norm = normalizeContent(r.buf);
          const { normalizedHash, lineCount, normalizedSize } = normalizedFingerprint(norm);
          fileInfo = {
            hash: sha256(r.buf),
            size: r.size,
            mtime: r.mtime,
            normalizedHash,
            lineCount,
            normalizedSize
          };
        }
      }
      if (fileInfo) {
        const freshState = loadState();
        freshState.files[rel] = fileInfo;
        freshState.last_run = new Date().toISOString();
        saveJsonState(VAULT_STATE_FILE, freshState);
        console.log(`Checkpoint: ${rel}`);
      }
    }

    if (!SKIP_INGEST && process.env.BRIDGE_URL && process.env.BRIDGE_API_KEY) {
      console.log("Ingest incremental...");
      const ir = spawnSync(
        process.execPath,
        [path.join(__dirname, "ingest-brain.js")],
        { cwd: REPO_ROOT, stdio: "inherit", env: process.env }
      );
      if (ir.status !== 0) {
        console.warn(`  (ingest falló con código ${ir.status}, continuando síntesis)`);
      }
    }

    } catch (sourceErr) {
      console.error(`\n  ERROR sintetizando ${rel}: ${sourceErr.message}`);
      failedSources.push({ path: rel, error: sourceErr.message });
      console.error("  Continuando con la siguiente fuente...\n");
    }
  }

  if (!FILE_ARG && !DRY && !ANALYSIS_ONLY && currentSnapshot) {
    console.log("\nActualizando snapshot completo del vault...");
    persistVaultSnapshot({
      currentSnapshot,
      prevFiles,
      failedPaths: failedSources.map((f) => f.path),
      icloudPending
    });
  }

  if (failedSources.length > 0) {
    console.error(`\n${failedSources.length} fuente(s) fallaron / incompletas:`);
    for (const f of failedSources) {
      console.error(`  - ${f.path}: ${f.error.slice(0, 200)}`);
    }
  }
  const softTrips = guardTrips.filter((g) => g.severity === "soft");
  if (softTrips.length > 0) {
    console.warn(
      `${softTrips.length} página(s) omitidas por fact-retention suave (sin aviso en el inbox):`
    );
    for (const g of softTrips) {
      console.warn(`  - ${g.path} → ${g.page}: ${g.reason.slice(0, 160)}`);
    }
  }

  if (!DRY && !ANALYSIS_ONLY) {
    syncWikiAlerts([...processedPaths, ...orphanedAlertPaths], failedSources);
  }

  console.log("\nHecho.");
}

/**
 * Reconcilia el estado de alertas con este run y deja el inbox al día:
 * fuentes procesadas sin fallo duro se resuelven, las fallidas se acumulan,
 * y si no queda nada pendiente se borra `⚠ wiki-sync.md`.
 */
function syncWikiAlerts(processedPaths, failedSources) {
  try {
    const { data } = loadJsonState(WIKI_ALERTS_STATE_FILE, WIKI_ALERTS_STATE_FILE, emptyAlertState);
    const nextState = mergePendingAlerts(normalizeAlertState(data), {
      processedPaths,
      hardFailures: failedSources,
      now: new Date().toISOString()
    });
    saveJsonState(WIKI_ALERTS_STATE_FILE, nextState);

    const result = syncAlertFile(VAULT_ROOT, nextState);
    if (result.action === "written") {
      console.error(`Aviso en inbox (${result.pending} pendiente(s)): ${result.path}`);
    } else if (result.action === "removed") {
      console.log("Sin fuentes pendientes: aviso del inbox eliminado.");
    }
  } catch (e) {
    console.error(`No se pudo actualizar el aviso del inbox: ${e.message}`);
  }
}

/** Los avisos por día quedan sustituidos por el fichero canónico. */
function cleanupLegacyWikiAlerts() {
  try {
    const { inboxDir } = alertFilePaths(VAULT_ROOT);
    const removed = cleanupLegacyAlertFiles(inboxDir);
    if (removed.length > 0) {
      console.log(`Limpieza: ${removed.length} aviso(s) antiguo(s) por día borrados del inbox.`);
    }
  } catch (e) {
    console.warn(`No se pudieron limpiar avisos antiguos: ${e.message}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
