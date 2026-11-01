/** Strip YAML frontmatter (kept local to avoid circular import with wiki-update-guard). */
function stripFrontmatter(md) {
  if (!md || !md.startsWith("---")) return md || "";
  const end = md.indexOf("\n---", 3);
  if (end === -1) return md;
  return md.slice(end + 4).replace(/^\r?\n/, "");
}

const PATTERNS = {
  iso_date: /\b\d{4}-\d{2}-\d{2}\b/g,
  eu_date: /\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g,
  money: /\b\d[\d.,]*\s?(?:€|EUR|\$|USD)\b/gi,
  percent: /\b\d[\d.,]*\s?%/g,
  magnitude: /\b\d[\d.,]*\s?(?:kWh|m³|m3|kg|km|h|k|K|M|MM)\b/g,
  wikilink: /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g,
  url: /https?:\/\/[^\s)>\]]+/g
};

/**
 * Extrae el conjunto de "hechos duros" de un markdown. Determinista y barato.
 * @param {string} md
 * @param {{ titleIndex?: Map<string, unknown> | { keys?: () => Iterable<string>, byTitle?: Map<string, unknown> } }} [opts]
 * @returns {Map<string, string>}
 */
export function extractFacts(md, { titleIndex } = {}) {
  const body = stripFrontmatter(md || "");
  const facts = new Map();
  for (const [type, re] of Object.entries(PATTERNS)) {
    for (const m of body.matchAll(re)) {
      const raw = type === "wikilink" ? m[1] : m[0];
      facts.set(raw.trim().toLowerCase().replace(/\s+/g, " "), type);
    }
  }
  if (titleIndex) {
    const low = body.toLowerCase();
    const titles =
      titleIndex instanceof Map
        ? titleIndex.keys()
        : titleIndex.byTitle
          ? titleIndex.byTitle.keys()
          : titleIndex.keys
            ? titleIndex.keys()
            : [];
    for (const title of titles) {
      const t = String(title).toLowerCase();
      if (t.length > 3 && low.includes(t)) facts.set(t, "entity");
    }
  }
  return facts;
}

/**
 * ¿Qué hechos del documento previo sobreviven al nuevo?
 * @returns {{ retention: number, total: number, lost: Array<{value:string,type:string}> }}
 */
export function factRetention(beforeMd, afterMd, opts) {
  const before = extractFacts(beforeMd, opts);
  const after = extractFacts(afterMd, opts);
  const lost = [];
  for (const [value, type] of before) {
    if (!after.has(value)) lost.push({ value, type });
  }
  const total = before.size;
  return { retention: total ? (total - lost.length) / total : 1, total, lost };
}
