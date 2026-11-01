/**
 * Utilidades puras del job prep:121 (preparación de 1:1 la víspera).
 */

export const BLOCK_START = "%% prep-121 start %%";
export const BLOCK_END = "%% prep-121 end %%";
export const NOTES_HEADING = "## Notas rápidas";

const ONE_ON_ONE = /(1 ?to ?1|\b1:1\b|\b121\b)/i;

/** "2026-09-29" → "2026.09.29" */
export function dailyFilename(isoDate) {
  return `${isoDate.replace(/-/g, ".")}.md`;
}

/**
 * Fecha ISO (YYYY-MM-DD) de "mañana" en una zona horaria dada.
 * @param {Date} [now] @param {string} [timeZone]
 */
export function tomorrowIso(now = new Date(), timeZone = "Europe/Madrid") {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Devuelve el contenido de una sección `## Título` (sin el encabezado) o "" si no existe. */
export function sectionBody(markdown, heading) {
  const lines = markdown.split("\n");
  const i = lines.findIndex((l) => l.trim() === heading);
  if (i < 0) return "";
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (/^## /.test(lines[j])) break;
    out.push(lines[j]);
  }
  return out.join("\n");
}

/**
 * Líneas de 1:1 pendientes (`[ ]` o `[<]`) en `## Trabajo`, con el nombre de la persona si va enlazado.
 * @returns {{ line: string, people: string[] }[]}
 */
export function findOneOnOnes(dailyMarkdown) {
  const body = sectionBody(dailyMarkdown, "## Trabajo");
  const res = [];
  for (const raw of body.split("\n")) {
    const m = raw.match(/^\s*- \[( |<)\]\s*(.*)$/);
    if (!m) continue;
    const text = m[2];
    if (!ONE_ON_ONE.test(text)) continue;
    if (/^~~.*~~/.test(text.trim())) continue; // tachado = movido a otro día
    const people = [...text.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)].map((x) => x[1].trim());
    res.push({ line: text.trim(), people });
  }
  return res;
}

/** Sustituye `{{CLAVE}}` en la plantilla. */
export function renderTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : `{{${k}}}`));
}

/**
 * Inserta (o reemplaza) el bloque de preparación justo debajo de `## Notas rápidas`.
 * Idempotente: si ya hay un bloque entre marcadores, lo sustituye.
 * @param {string} dailyMarkdown @param {string} body markdown generado (sus `## ` bajan a `#### `)
 * @param {{ generatedAt: string }} meta
 */
export function upsertPrepBlock(dailyMarkdown, body, { generatedAt }) {
  const block = [
    BLOCK_START,
    `### 🤝 Prep 1:1 (generado el ${generatedAt})`,
    body.trim().replace(/^## /gm, "#### "),
    BLOCK_END
  ].join("\n");

  // 1) Quitar bloque previo si existe.
  const re = new RegExp(`\\n?${escapeRe(BLOCK_START)}[\\s\\S]*?${escapeRe(BLOCK_END)}\\n?`, "g");
  let text = dailyMarkdown.replace(re, "\n");

  // 2) Insertar bajo el encabezado de notas rápidas (o crear la sección al final).
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.trim() === NOTES_HEADING);
  if (i >= 0) {
    lines.splice(i + 1, 0, block);
    text = lines.join("\n");
  } else {
    text = `${text.replace(/\s*$/, "")}\n\n${NOTES_HEADING}\n${block}\n`;
  }
  return text;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
