/**
 * Pre-write guards for wiki page updates from synthesize-wiki.
 * Detects diff-style placeholder lines (Signal A), catastrophic shrink (Signal B),
 * and hard-fact loss (Signal C via wiki-fact-retention).
 *
 * Severidad: todo trip evita escribir la página, pero solo los `hard` bloquean el
 * checkpoint de la fuente y generan aviso en el inbox. Signal C con retención por
 * encima de WIKI_ALERT_FACT_RETENTION (default 0.5) es `soft`: ruido de consola.
 */

import { factRetention } from "./wiki-fact-retention.js";

const CATASTROPHIC_SHRINK_RATIO = 0.2;
const DEFAULT_MIN_BODY_RATIO = 0.5;
const DEFAULT_ALERT_FACT_RETENTION = 0.5;
const DEFAULT_EXISTING_PAGE_MAX_CHARS = 100_000;
const DEFAULT_PAGE_SPLIT_WARN_CHARS = 25_000;

/** Keywords that indicate omission/placeholder phrasing (case-insensitive). */
const PLACEHOLDER_KEYWORDS = [
  "unchanged",
  "no changes?",
  "same as before",
  "as (above|before)",
  "sin cambios",
  "existing content",
  "previous version",
  "versión anterior",
  "contenido (?:previo|existente|anterior|sin cambios)",
  "(?:el )?resto (?:queda|permanece|sigue|se mantiene)",
  "rest of (?:the )?(?:page|content|document|file)",
  "remains? (?:the same|unchanged)"
];

const PLACEHOLDER_KEYWORD_RE = new RegExp(PLACEHOLDER_KEYWORDS.join("|"), "i");
const PLACEHOLDER_INLINE_RE = PLACEHOLDER_KEYWORD_RE;

/** Line that is essentially only a bracket/paren marker with placeholder keywords. */
const BRACKET_MARKER_RE = new RegExp(
  `^\\s*[[(][^\\])]*(?:${PLACEHOLDER_KEYWORDS.join("|")})[^\\])]*[\\])]\\s*$`,
  "i"
);

/** Standalone ellipsis lines: [...], […], … */
const ELLIPSIS_LINE_RE = /^\s*(?:\[\.\.\.\]|\[…\]|…)\s*$/;

function resolveMinBodyRatio() {
  const raw = process.env.WIKI_UPDATE_MIN_BODY_RATIO?.trim();
  if (raw == null || raw === "") return DEFAULT_MIN_BODY_RATIO;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return DEFAULT_MIN_BODY_RATIO;
  return n;
}

/** Umbral por debajo del cual una pérdida de hechos pasa a ser fallo duro. */
function resolveAlertFactRetention() {
  const raw = process.env.WIKI_ALERT_FACT_RETENTION?.trim();
  if (raw == null || raw === "") return DEFAULT_ALERT_FACT_RETENTION;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return DEFAULT_ALERT_FACT_RETENTION;
  return n;
}

/**
 * Strips YAML frontmatter from markdown.
 * @param {string} md
 * @returns {string}
 */
export function stripFrontmatter(md) {
  if (!md || !md.startsWith("---")) return md || "";
  const end = md.indexOf("\n---", 3);
  if (end === -1) return md;
  return md.slice(end + 4).replace(/^\r?\n/, "");
}

/**
 * Collapses whitespace for length comparison.
 * @param {string} text
 * @returns {string}
 */
function collapseWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

/**
 * Signal A: finds a body line that is essentially a diff placeholder marker.
 * @param {string} body — markdown body without frontmatter
 * @returns {string | null} offending line or null
 */
export function findPlaceholderLine(body) {
  if (!body) return null;
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (ELLIPSIS_LINE_RE.test(trimmed)) {
      return trimmed;
    }

    if (BRACKET_MARKER_RE.test(line)) {
      return trimmed;
    }
  }
  return null;
}

/**
 * Signal B helper: inline placeholder phrasing anywhere in body (not line-only).
 * @param {string} body
 * @returns {boolean}
 */
function hasInlinePlaceholderPhrase(body) {
  return PLACEHOLDER_INLINE_RE.test(body);
}

/**
 * Detects pages that exceed the synthesis context cap (hard) or the hub split
 * target (soft). Call BEFORE the LLM update so oversized pages cost nothing.
 *
 * @param {string} existingMd
 * @param {{
 *   hardCap?: number,
 *   warnChars?: number,
 *   pageLabel?: string
 * }} [opts]
 * @returns {{ oversized: boolean, reason: string | null, severity: "soft" | "hard" | null, length: number }}
 */
export function detectOversizedPage(existingMd, opts = {}) {
  const length = String(existingMd || "").length;
  const hardCap = Number(
    opts.hardCap ?? process.env.WIKI_EXISTING_PAGE_MAX_CHARS ?? DEFAULT_EXISTING_PAGE_MAX_CHARS
  );
  const warnChars = Number(
    opts.warnChars ?? process.env.WIKI_PAGE_SPLIT_WARN_CHARS ?? DEFAULT_PAGE_SPLIT_WARN_CHARS
  );
  const label = opts.pageLabel || "page";

  if (Number.isFinite(hardCap) && hardCap > 0 && length > hardCap) {
    return {
      oversized: true,
      severity: "hard",
      length,
      reason:
        `oversized page ${label}: ${length.toLocaleString()} chars > hard cap ${hardCap.toLocaleString()} ` +
        `(WIKI_EXISTING_PAGE_MAX_CHARS). Split the hub into child pages per vault CLAUDE.md; ` +
        `do not raise the cap.`
    };
  }

  if (Number.isFinite(warnChars) && warnChars > 0 && length > warnChars) {
    return {
      oversized: true,
      severity: "soft",
      length,
      reason:
        `page ${label} at ${length.toLocaleString()} chars exceeds split warn target ` +
        `${warnChars.toLocaleString()} (WIKI_PAGE_SPLIT_WARN_CHARS). Consider a hub/child split ` +
        `before it hits the hard cap.`
    };
  }

  return { oversized: false, reason: null, severity: null, length };
}

/**
 * Detects suspicious LLM update output before writing.
 * @param {string} existingMd
 * @param {string} mergedMd
 * @param {{ titleIndex?: object }} [opts]
 * @returns {{ suspicious: boolean, reason: string | null, severity: "soft" | "hard" | null }}
 */
export function detectSuspiciousUpdate(existingMd, mergedMd, opts = {}) {
  const existingBody = stripFrontmatter(existingMd);
  const mergedBody = stripFrontmatter(mergedMd);

  const placeholderLine = findPlaceholderLine(mergedBody);
  if (placeholderLine) {
    return {
      suspicious: true,
      severity: "hard",
      reason: `placeholder marker line detected: "${placeholderLine.slice(0, 120)}"`
    };
  }

  const existingLen = collapseWhitespace(existingBody).length;
  const mergedLen = collapseWhitespace(mergedBody).length;

  if (existingLen < 200) {
    return { suspicious: false, reason: null, severity: null };
  }

  const ratio = mergedLen / existingLen;
  const minBodyRatio = resolveMinBodyRatio();

  if (ratio < CATASTROPHIC_SHRINK_RATIO) {
    return {
      suspicious: true,
      severity: "hard",
      reason:
        `catastrophic body shrink (${Math.round(ratio * 100)}% of previous length, threshold ${Math.round(CATASTROPHIC_SHRINK_RATIO * 100)}%). ` +
        "If this condensation is deliberate, apply the edit manually or temporarily adjust the guard; " +
        "WIKI_UPDATE_MIN_BODY_RATIO does not control this catastrophic threshold."
    };
  }

  if (ratio < minBodyRatio && hasInlinePlaceholderPhrase(mergedBody)) {
    return {
      suspicious: true,
      severity: "hard",
      reason:
        `moderate body shrink (${Math.round(ratio * 100)}% of previous length) combined with inline placeholder phrasing ` +
        `(threshold WIKI_UPDATE_MIN_BODY_RATIO=${minBodyRatio}). ` +
        "If legitimate, raise WIKI_UPDATE_MIN_BODY_RATIO temporarily or apply the edit manually."
    };
  }

  // Signal C: pérdida de hechos duros. Umbral laxo (default 0.9).
  // WIKI_MIN_FACT_RETENTION=0 desactiva.
  // Severidad: soft mientras la retención siga por encima de WIKI_ALERT_FACT_RETENTION;
  // por debajo es hard (pérdida masiva, no una condensación agresiva).
  const minFactRetention = Number(process.env.WIKI_MIN_FACT_RETENTION ?? 0.9);
  if (minFactRetention > 0) {
    const { retention, total, lost } = factRetention(existingMd, mergedMd, opts);
    if (total >= 5 && retention < minFactRetention) {
      const alertRetention = resolveAlertFactRetention();
      return {
        suspicious: true,
        severity: retention >= alertRetention ? "soft" : "hard",
        reason:
          `fact loss: retención ${(retention * 100).toFixed(1)}% (${lost.length}/${total} hechos perdidos). ` +
          `Perdidos: ${lost
            .slice(0, 8)
            .map((f) => f.value)
            .join(", ")}${lost.length > 8 ? "…" : ""}.`
      };
    }
  }

  return { suspicious: false, reason: null, severity: null };
}

/**
 * For creates: only Signal A applies.
 * @param {string} md
 * @returns {{ suspicious: boolean, reason: string | null, severity: "soft" | "hard" | null }}
 */
export function detectSuspiciousCreate(md) {
  const body = stripFrontmatter(md);
  const placeholderLine = findPlaceholderLine(body);
  if (placeholderLine) {
    return {
      suspicious: true,
      severity: "hard",
      reason: `placeholder marker line detected: "${placeholderLine.slice(0, 120)}"`
    };
  }
  return { suspicious: false, reason: null, severity: null };
}
