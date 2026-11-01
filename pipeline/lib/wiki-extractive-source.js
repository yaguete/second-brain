/**
 * Deterministic extractive source page builder (no LLM).
 * Preserves tables, dated headings/entries, and key/value-ish lines verbatim.
 */

import { parseFrontmatter } from "./brain-wiki.js";
import { normalizePathKey } from "./vault-diff.js";
import { extractFacts } from "./wiki-fact-retention.js";
import { todayUtc } from "../../bridge/src/shared/brain-date.js";

function yamlString(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function yamlList(items) {
  if (!items || items.length === 0) return "[]";
  return `\n${items.map((i) => `  - ${yamlString(i)}`).join("\n")}`;
}

function isTableLine(line) {
  return /^\s*\|/.test(line);
}

function isDatedHeading(line) {
  return (
    /^#{2,4}\s+\d{4}-\d{2}-\d{2}/.test(line) ||
    /^#{2,4}\s+.*\d{4}[-./]\d{1,2}[-./]\d{1,2}/.test(line)
  );
}

function isKeyValueLine(line) {
  const t = line.trim();
  if (!t.startsWith("-") && !t.startsWith("*")) return false;
  // "**Label:** value" (colon inside or after bold) or "- Label: value"
  return /\*\*[^*]+?\*\*\s*:/.test(t) || /\*\*[^*]+?:\*\*/.test(t) || /:\s+\S/.test(t);
}

function isHeading(line) {
  return /^#{1,6}\s+\S/.test(line);
}

/**
 * Extract keep-worthy lines: all tables (contiguous), dated heading sections,
 * and key/value bullet lines. Preserves relative order.
 * @param {string} body
 * @returns {string}
 */
export function extractVerbatimBody(body) {
  const lines = String(body || "").split(/\r?\n/);
  const keep = new Array(lines.length).fill(false);

  // Mark table blocks
  for (let i = 0; i < lines.length; i++) {
    if (isTableLine(lines[i])) keep[i] = true;
  }

  // Mark dated headings and following structured lines until next same-or-higher heading
  for (let i = 0; i < lines.length; i++) {
    if (!isDatedHeading(lines[i])) continue;
    keep[i] = true;
    const level = (lines[i].match(/^#+/) || ["##"])[0].length;
    for (let j = i + 1; j < lines.length; j++) {
      if (isHeading(lines[j])) {
        const lv = (lines[j].match(/^#+/) || ["#"])[0].length;
        if (lv <= level) break;
        // Nested heading under dated section — keep if also dated, else skip body of undated
        if (isDatedHeading(lines[j])) keep[j] = true;
        continue;
      }
      if (isTableLine(lines[j]) || isKeyValueLine(lines[j])) {
        keep[j] = true;
        continue;
      }
      // Blank lines between structured rows are fine (re-added as separators later)
      if (lines[j].trim() === "") continue;
      // Free prose inside a dated section is dropped
    }
  }

  // Key/value bullets and their immediate context headings
  for (let i = 0; i < lines.length; i++) {
    if (isKeyValueLine(lines[i])) keep[i] = true;
  }

  // Keep any line that itself carries a hard fact (dates, money, ISINs-as-text, etc.)
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) continue;
    if (!lines[i].trim() || isHeading(lines[i])) continue;
    if (extractFacts(lines[i]).size > 0) keep[i] = true;
  }

  // Always keep top-level # title if present
  if (lines[0] && /^#\s+/.test(lines[0])) keep[0] = true;

  // Compact: emit kept lines, collapse runs of blank lines
  const out = [];
  let blank = false;
  let any = false;
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) {
      // insert a single blank as separator when dropping a gap between kept blocks
      if (any && out.length && out[out.length - 1] !== "") blank = true;
      continue;
    }
    if (blank && lines[i].trim() !== "") {
      out.push("");
      blank = false;
    }
    out.push(lines[i]);
    any = true;
    if (lines[i].trim() === "") blank = false;
  }

  const text = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return text || "_No extractable tables or dated entries found in source._";
}

/**
 * @param {{
 *   sourceRel: string,
 *   sourceContent: string,
 *   filename: string,
 *   title?: string,
 *   eventDate?: string | null,
 *   tags?: string[]
 * }} opts
 * @returns {string} full markdown with frontmatter
 */
export function buildExtractiveSourcePage(opts) {
  const sourceRel = normalizePathKey(opts.sourceRel);
  const { data, body } = parseFrontmatter(opts.sourceContent);
  const extracted = extractVerbatimBody(body);
  const today = todayUtc();
  const title =
    opts.title ||
    (data.title ? String(data.title) : sourceRel.split("/").pop()?.replace(/\.md$/i, "") || "Untitled");
  const tags = Array.isArray(opts.tags)
    ? opts.tags
    : Array.isArray(data.tags)
      ? data.tags.map(String)
      : [];

  const fm = [
    `title: ${yamlString(title)}`,
    `type: source`,
    `extractive: true`,
    `created: ${today}`,
    `updated: ${today}`,
    `source_vault: ${yamlString(sourceRel)}`,
    `sources:${yamlList([sourceRel])}`,
    `tags:${tags.length ? yamlList(tags) : " []"}`
  ];
  if (opts.eventDate) fm.splice(5, 0, `event_date: ${opts.eventDate}`);

  return `---\n${fm.join("\n")}\n---\n\n# ${title}\n\n> Página extractiva (sin resumen LLM). Tablas y entradas fechadas copiadas verbatim de \`${sourceRel}\`.\n\n${extracted}\n`;
}
