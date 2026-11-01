/**
 * Filtro determinista (sin LLM) de fuentes demasiado vacías para sintetizar.
 * Las daily notes se miden por caracteres útiles tras quitar la plantilla fija.
 */

export const DAILY_NOTES_PREFIX = "🗓️ Daily notes/";

/** Contenido mínimo en bytes (solo fuentes que no son daily notes). */
export const MIN_SYNTHESIS_BYTES = 200;

/** Tras quitar plantilla daily, si queda menos que esto → template_only. */
export const MIN_DAILY_USEFUL_CHARS = 50;

/** Líneas-guía del cierre en Resources/Templates/Daily.md (coincidencia por substring). */
export const DAILY_CLOSURE_MARKERS = [
  "explorado algo nuevo",
  "conseguido avanzar",
  "cuello de botella",
  "llevarme a mañana",
  "No te olvides"
];

/** `- [ ] …` no hecho. No pega a `[x]`, `[<]`, `[/]`, `[-]`, etc. */
const UNCHECKED_TASK_RE = /^\s*-\s*\[\s*\](?:\s|$)/;

/** Placeholder vacío de la plantilla Daily: `- [ ] [ ]`. */
const EMPTY_DOUBLE_CHECKBOX_RE = /^\s*-\s*\[\s*\]\s*\[\s*\]\s*$/;

/**
 * Quita frontmatter y líneas fijas de la plantilla Daily (habit tracker,
 * secciones vacías, cierre, tareas `- [ ]` no hechas).
 * `[x]` y `[<]` se conservan: son hecho / reagendado.
 * @param {string} raw
 * @returns {string} texto útil colapsado para medir longitud
 */
export function extractDailyUsefulContent(raw) {
  let body = String(raw || "");
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end !== -1) body = body.slice(end + 4).replace(/^\r?\n/, "");
  }
  const lines = body.split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (/^#{1,6}\s/.test(trimmed)) continue;
    if (trimmed.includes("|")) continue;
    if (/^\|[\s\-:|]+\|$/.test(trimmed)) continue;
    if (EMPTY_DOUBLE_CHECKBOX_RE.test(line)) continue;
    if (UNCHECKED_TASK_RE.test(line)) continue;
    if (/^\s*-\s*$/.test(trimmed)) continue;
    if (DAILY_CLOSURE_MARKERS.some((m) => trimmed.includes(m))) continue;
    kept.push(trimmed);
  }
  return kept.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * @param {string} relPath
 * @param {string} content
 * @returns {{ skip: boolean, reason?: string, detail?: string }}
 */
export function shouldSkipContent(relPath, content) {
  const byteLen = Buffer.byteLength(String(content || ""), "utf8");

  if (String(relPath || "").startsWith(DAILY_NOTES_PREFIX)) {
    const useful = extractDailyUsefulContent(content);
    if (useful.length < MIN_DAILY_USEFUL_CHARS) {
      return {
        skip: true,
        reason: "template_only",
        detail: `(${useful.length} chars útiles < ${MIN_DAILY_USEFUL_CHARS})`
      };
    }
    return { skip: false };
  }

  if (byteLen < MIN_SYNTHESIS_BYTES) {
    return { skip: true, reason: "too_small", detail: `(${byteLen} bytes < ${MIN_SYNTHESIS_BYTES})` };
  }
  return { skip: false };
}
