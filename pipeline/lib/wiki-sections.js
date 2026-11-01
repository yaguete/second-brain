/**
 * Parseo y parche quirúrgico de secciones `##` en páginas wiki.
 * Usado por synthesize-wiki cuando la página es demasiado grande para
 * reescribirla entera (DeepSeek corta la conexión / el JSON).
 */

import { normForCompare } from "./brain-wiki.js";

const SEE_ALSO_RE = /^(ver también|see also)$/i;

export function countH2(md) {
  return (String(md || "").match(/^##\s+\S/gm) || []).length;
}

/**
 * @param {string} md
 * @returns {{ fm: string, preamble: string, sections: Array<{ title: string, body: string }> }}
 */
export function parseMarkdownSections(md) {
  const raw = String(md || "");
  let fm = "";
  let body = raw;
  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3);
    if (end !== -1) {
      fm = raw.slice(0, end + 4);
      body = raw.slice(end + 4).replace(/^\r?\n/, "");
    }
  }

  const lines = body.split(/\r?\n/);
  const preambleLines = [];
  /** @type {Array<{ title: string, body: string }>} */
  const sections = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) {
      if (current) sections.push(current);
      current = { title: m[1].trim(), body: line };
    } else if (current) {
      current.body += `\n${line}`;
    } else {
      preambleLines.push(line);
    }
  }
  if (current) sections.push(current);

  return {
    fm,
    preamble: preambleLines.join("\n").replace(/^\n+/, "").replace(/\n+$/, ""),
    sections
  };
}

export function serializeMarkdownSections({ fm = "", preamble = "", sections = [] }) {
  const parts = [];
  if (fm) parts.push(String(fm).trimEnd());
  if (preamble) parts.push(String(preamble).replace(/\n+$/, ""));
  for (const s of sections) {
    parts.push(String(s.body || "").replace(/\n+$/, ""));
  }
  return `${parts.join("\n\n")}\n`;
}

export function findSectionIndex(sections, title) {
  const want = normForCompare(title);
  if (!want) return -1;
  const exact = sections.findIndex((s) => normForCompare(s.title) === want);
  if (exact >= 0) return exact;
  return sections.findIndex((s) => {
    const have = normForCompare(s.title);
    return have.includes(want) || want.includes(have);
  });
}

export function sectionOutline(sections) {
  return (sections || [])
    .map((s) => `- ${s.title} (${String(s.body || "").length.toLocaleString()} chars)`)
    .join("\n");
}

/**
 * Elige 1–N secciones cuyo título solapa con `reason` / `preferredTitle`.
 * @param {Array<{ title: string, body: string }>} sections
 * @param {string} [reason]
 * @param {{ maxChars?: number, maxSections?: number, preferredTitle?: string }} [opts]
 */
export function selectSectionsForPrompt(sections, reason = "", opts = {}) {
  const maxChars = opts.maxChars ?? 12_000;
  const maxSections = opts.maxSections ?? 3;
  const list = Array.isArray(sections) ? sections : [];
  if (list.length === 0) return [];

  const reasonNorm = normForCompare(reason);
  const reasonWords = new Set(reasonNorm.split(" ").filter((w) => w.length >= 4));
  const preferred = normForCompare(opts.preferredTitle);

  const scored = list.map((s, i) => {
    const titleNorm = normForCompare(s.title);
    let score = 0;
    if (preferred && (titleNorm === preferred || titleNorm.includes(preferred) || preferred.includes(titleNorm))) {
      score += 100;
    }
    for (const w of reasonWords) {
      if (titleNorm.includes(w)) score += 3;
    }
    if (/estado actual|cronolog|hitos|pendientes|decision/.test(titleNorm)) score += 2;
    if (SEE_ALSO_RE.test(s.title)) score -= 5;
    return { s, i, score };
  });

  scored.sort((a, b) => b.score - a.score || a.i - b.i);

  const picked = [];
  let used = 0;
  for (const row of scored) {
    if (picked.length >= maxSections) break;
    if (picked.length > 0 && used + row.s.body.length > maxChars) continue;
    picked.push(row.s);
    used += row.s.body.length;
  }
  if (picked.length === 0) picked.push(list[0]);
  return picked;
}

/**
 * Reemplaza o inserta UNA sección `##`. El resto de la página no se toca.
 * @param {string} md
 * @param {{ section?: string, markdown: string }} patch
 */
export function applySectionPatch(md, patch) {
  const parsed = parseMarkdownSections(md);
  let body = String(patch?.markdown || "").trim();
  if (!body) throw new Error("section patch missing markdown");

  const headingFromMd = (body.match(/^##\s+(.+)$/m) || [])[1];
  const title = String(headingFromMd || patch.section || "").trim();
  if (!title) throw new Error("section patch missing ## title");
  if (!/^##\s+/m.test(body)) body = `## ${title}\n\n${body}`;

  const idx = findSectionIndex(parsed.sections, title);
  if (idx >= 0) {
    parsed.sections[idx] = { title: parsed.sections[idx].title, body };
  } else {
    const newSec = { title, body };
    const seeIdx = parsed.sections.findIndex((s) => SEE_ALSO_RE.test(s.title));
    if (seeIdx >= 0) parsed.sections.splice(seeIdx, 0, newSec);
    else parsed.sections.push(newSec);
  }
  return serializeMarkdownSections(parsed);
}

const MONTHS_ES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre"
];

/**
 * Título de una "foto" fechada: `Base (a 18/10/2026)`, `Estado a 7 de septiembre de 2026 (…)`
 * o `Estado actual (a 24 de agosto de 2026)`.
 * @returns {{ base: string, date: string, month: string } | null} date ISO, month en castellano
 */
export function snapshotKey(title) {
  const t = String(title || "").trim();
  let m = t.match(/^(.+?)\s*\(a (\d{1,2})\/(\d{1,2})\/(\d{4})\)$/);
  if (m) return buildKey(m[1], m[4], Number(m[3]), m[2]);
  m = t.match(/^(.+?)\s*\(?\ba (\d{1,2}) de ([a-záéíóú]+) de (\d{4})\b/i);
  if (m) {
    const month = MONTHS_ES.indexOf(m[3].toLowerCase()) + 1;
    if (month > 0) return buildKey(m[1], m[4], month, m[2]);
  }
  return null;
}

function buildKey(base, year, month, day) {
  if (month < 1 || month > 12) return null;
  const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { base: normForCompare(base), date, month: MONTHS_ES[month - 1] };
}

/**
 * Deja en la página solo la foto más reciente de cada serie fechada (misma base de título)
 * y devuelve las anteriores para archivarlas en las páginas de cronología.
 * @param {string} md
 * @returns {{ md: string, archived: Array<{ title: string, body: string, date: string, month: string }> }}
 */
export function rotateDatedSnapshots(md) {
  const parsed = parseMarkdownSections(md);
  const latest = new Map();
  for (const s of parsed.sections) {
    const key = snapshotKey(s.title);
    if (key && (!latest.has(key.base) || latest.get(key.base) < key.date)) latest.set(key.base, key.date);
  }
  const archived = [];
  const sections = parsed.sections.filter((s) => {
    const key = snapshotKey(s.title);
    if (!key || latest.get(key.base) === key.date) return true;
    archived.push({ title: s.title, body: s.body, date: key.date, month: key.month });
    return false;
  });
  if (archived.length === 0) return { md, archived };
  return { md: serializeMarkdownSections({ ...parsed, sections }), archived };
}
