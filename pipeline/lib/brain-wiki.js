import fs from "fs";
import path from "path";
import crypto from "crypto";

export const WIKI_SUBDIRS = ["sources", "entities", "concepts", "synthesis", "essays"];
export const WIKI_EXCLUDED_FILES = new Set(["index.md", "log.md"]);
export const WIKI_EXCLUDED_PREFIXES = ["logs/"];

export function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

export function wikiRoot(vaultRoot, wikiDirName = "📒 Wiki") {
  return path.join(vaultRoot, wikiDirName);
}

export function walkMd(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).split(path.sep).join("/").normalize("NFC");
    if (WIKI_EXCLUDED_PREFIXES.some((prefix) => rel === prefix.slice(0, -1) || rel.startsWith(prefix))) {
      continue;
    }
    if (e.isDirectory()) {
      if (e.name === "📒 Wiki") continue;
      walkMd(full, base, out);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      if (WIKI_EXCLUDED_FILES.has(e.name)) continue;
      out.push({ fullPath: full, relFromWiki: rel });
    }
  }
}

export function listWikiMarkdownFiles(vaultRoot, wikiDirName = "📒 Wiki") {
  const root = wikiRoot(vaultRoot, wikiDirName);
  const out = [];
  for (const sub of WIKI_SUBDIRS) {
    const dir = path.join(root, sub);
    if (!fs.existsSync(dir)) continue;
    walkMd(dir, root, out);
  }
  return out;
}

/**
 * Parse YAML-ish frontmatter. Supports:
 * - scalars (optionally quoted)
 * - inline arrays: `tags: [a, b]`
 * - block sequences: `sources:\n  - path\n  - other`
 * @returns {{ data: Record<string, unknown>, body: string }}
 */
export function parseFrontmatter(raw) {
  if (!raw.startsWith("---")) return { data: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { data: {}, body: raw };
  const fmBlock = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  const data = {};
  const lines = fmBlock.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();

    if (val === "" || val === "|" || val === ">") {
      // Block sequence: collect following `- item` lines.
      const items = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const next = lines[j];
        const item = next.match(/^\s+-\s+(.*)$/);
        if (item) {
          items.push(item[1].trim().replace(/^["']|["']$/g, ""));
          continue;
        }
        // Blank line inside a list is tolerated; a new key ends the list.
        if (/^\s*$/.test(next)) continue;
        if (/^[\w-]+:\s*/.test(next)) break;
        // Indented continuation of previous scalar — ignore for our subset.
        if (/^\s+\S/.test(next)) continue;
        break;
      }
      if (items.length > 0 || val === "") {
        data[key] = items;
        i = j - 1;
        continue;
      }
    }

    if (val.startsWith("[") && val.endsWith("]")) {
      const inner = val.slice(1, -1).trim();
      data[key] = inner
        ? inner.split(",").map((t) => t.trim().replace(/^["']|["']$/g, ""))
        : [];
    } else {
      data[key] = val.replace(/^["']|["']$/g, "");
    }
  }
  return { data, body };
}

export function normForCompare(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Index section order and heading labels (matches vault CLAUDE.md). */
export const WIKI_INDEX_SECTIONS = [
  { subdir: "sources", heading: "Sources", dateStyle: true },
  { subdir: "entities", heading: "Entities", dateStyle: false },
  { subdir: "concepts", heading: "Concepts", dateStyle: false },
  { subdir: "synthesis", heading: "Synthesis", dateStyle: true },
  { subdir: "essays", heading: "Essays", dateStyle: true }
];

function wikiIndexSlug(fullPath) {
  return path.basename(fullPath, ".md");
}

function wikiIndexTitle(data, slug) {
  return data.title ? String(data.title) : slug;
}

function wikiIndexDate(data) {
  const raw = data.event_date || data.created;
  if (!raw) return null;
  const s = String(raw).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function wikiIndexSourceCount(data, raw) {
  const src = data.sources;
  if (Array.isArray(src)) return src.length;
  if (src && typeof src === "string" && src.trim()) return 1;
  return countFrontmatterListItems(raw, "sources");
}

/** Counts `- item` lines under a YAML list key in frontmatter (multiline arrays). */
function countFrontmatterListItems(raw, key) {
  if (!raw.startsWith("---")) return 0;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return 0;
  const fmBlock = raw.slice(3, end);
  const lines = fmBlock.split(/\r?\n/);
  let inList = false;
  let count = 0;
  for (const line of lines) {
    if (!inList) {
      if (new RegExp(`^${key}:\\s*$`).test(line.trim())) {
        inList = true;
      } else if (new RegExp(`^${key}:\\s*\\[`).test(line.trim())) {
        const inline = line.trim().slice(key.length + 1).trim();
        if (inline === "[]") return 0;
        const inner = inline.slice(1, -1).trim();
        return inner ? inner.split(",").length : 0;
      }
      continue;
    }
    if (/^\s*-\s+/.test(line)) {
      count++;
      continue;
    }
    if (/^\S/.test(line)) break;
  }
  return count;
}

function wikiIndexEntryLine(slug, title, meta, dateStyle) {
  const suffix = dateStyle
    ? meta.date
      ? ` (${meta.date})`
      : ""
    : ` (${meta.sourceCount} sources)`;
  return `- [[${slug}|${title}]]${suffix}`;
}

/**
 * Índice compacto para el prompt de análisis: cobertura completa, sin descripciones.
 * Medido en el vault real: ~35k chars vs ~79k de index.md (−55%), misma cobertura.
 */
export function buildWikiCompactIndex(vaultRoot, wikiDirName = "📒 Wiki") {
  const byDir = {};
  for (const p of listWikiMarkdownFiles(vaultRoot, wikiDirName)) {
    const base = path.basename(p.relFromWiki);
    if (base === "index.md" || base === "log.md") continue;
    if (p.relFromWiki.startsWith("logs/")) continue;
    const parts = p.relFromWiki.split("/");
    const dir = parts.length > 1 ? parts[0] : ".";
    (byDir[dir] ||= []).push(parts.slice(1).join("/") || base);
  }
  return Object.keys(byDir)
    .sort()
    .map((d) => `${d}/\n${byDir[d].sort().map((f) => `  ${f}`).join("\n")}`)
    .join("\n\n");
}

/**
 * Rebuilds 📒 Wiki/index.md deterministically from wiki page frontmatter.
 * Idempotent: same vault state → same index output.
 */
export function buildWikiIndexMarkdown(vaultRoot, wikiDirName = "📒 Wiki") {
  const bySubdir = new Map(WIKI_INDEX_SECTIONS.map(({ subdir }) => [subdir, []]));

  for (const { fullPath, relFromWiki } of listWikiMarkdownFiles(vaultRoot, wikiDirName)) {
    const subdir = relFromWiki.split("/")[0];
    if (!bySubdir.has(subdir)) continue;
    const raw = fs.readFileSync(fullPath, "utf8");
    const { data } = parseFrontmatter(raw);
    const slug = wikiIndexSlug(fullPath);
    bySubdir.get(subdir).push({
      slug,
      title: wikiIndexTitle(data, slug),
      date: wikiIndexDate(data),
      sourceCount: wikiIndexSourceCount(data, raw)
    });
  }

  const lines = ["# Wiki Index", ""];

  for (const { subdir, heading, dateStyle } of WIKI_INDEX_SECTIONS) {
    const entries = bySubdir.get(subdir) || [];
    entries.sort((a, b) => a.slug.localeCompare(b.slug, "en"));
    lines.push(`## ${heading}`, "");
    for (const e of entries) {
      lines.push(wikiIndexEntryLine(e.slug, e.title, e, dateStyle));
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function buildWikiTitleIndex(vaultRoot, wikiDirName = "📒 Wiki") {
  const index = {
    byFilename: new Map(),
    byTitle: new Map()
  };
  for (const { fullPath } of listWikiMarkdownFiles(vaultRoot, wikiDirName)) {
    const filename = path.basename(fullPath).normalize("NFC");
    const raw = fs.readFileSync(fullPath, "utf8");
    const { data } = parseFrontmatter(raw);
    const title = data.title ? String(data.title) : filename.replace(/\.md$/i, "");
    index.byFilename.set(filename, { title, fullPath });
    const norm = normForCompare(title);
    if (!index.byTitle.has(norm)) index.byTitle.set(norm, []);
    index.byTitle.get(norm).push(filename);
  }
  return index;
}

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 50;
const SINGLE_CHUNK_THRESHOLD = 2500;

function chunkText(text, { overlap = CHUNK_OVERLAP } = {}) {
  const trimmed = text.trim();
  if (trimmed.length <= SINGLE_CHUNK_THRESHOLD) {
    return trimmed.length > 20 ? [trimmed] : [];
  }
  const chunks = [];
  let start = 0;
  while (start < trimmed.length) {
    const end = Math.min(start + CHUNK_SIZE, trimmed.length);
    chunks.push(trimmed.slice(start, end).trim());
    if (end >= trimmed.length) break;
    start += CHUNK_SIZE - overlap;
  }
  return chunks.filter((c) => c.length > 20);
}

function splitByParagraphs(text, maxLen = SINGLE_CHUNK_THRESHOLD) {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed.length > 20 ? [trimmed] : [];

  const paragraphs = trimmed.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = "";

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length <= maxLen) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (para.length <= maxLen) {
      current = para;
    } else {
      chunks.push(...chunkText(para, { overlap: CHUNK_OVERLAP }));
      current = "";
    }
  }
  if (current) chunks.push(current);
  return chunks.filter((c) => c.length > 20);
}

/** Split markdown body by ## headers; embed only clean markdown content */
export function chunkMarkdown(body) {
  const parts = body.split(/^##\s+/m).filter(Boolean);
  if (parts.length <= 1) {
    return splitByParagraphs(body);
  }

  const chunks = [];
  // El preámbulo (antes del primer ##) también se trocea: si no, una página con
  // un preámbulo largo genera un chunk que excede el contexto del embedding.
  const first = parts[0].trim();
  if (first) chunks.push(...splitByParagraphs(`# ${first}`));
  for (let i = 1; i < parts.length; i++) {
    const section = `## ${parts[i]}`.trim();
    if (section.length <= SINGLE_CHUNK_THRESHOLD) {
      if (section.length > 20) chunks.push(section);
    } else {
      chunks.push(...splitByParagraphs(section));
    }
  }
  return chunks;
}
