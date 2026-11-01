#!/usr/bin/env node

/**
 * Auditoría one-off de páginas wiki ya escritas: detecta placeholders de diff
 * (corrupción probable) y cuerpos anómalamente cortos (revisión manual).
 *
 * Solo lectura — no modifica ningún archivo.
 *
 * Uso:
 *   node --env-file=.env scripts/audit-wiki-placeholders.js
 *   node scripts/audit-wiki-placeholders.js --min-body-chars 120
 *
 * Env:
 *   OBSIDIAN_VAULT_PATH (obligatoria; no hay ruta por defecto)
 *   BRAIN_WIKI_DIR_NAME (default: "📒 Wiki")
 *   WIKI_AUDIT_MIN_BODY_CHARS (default: 150) — umbral SHORT
 *
 * Exit code: siempre 0 (informativo, no gate).
 */

import { requireVaultPath } from "./lib/layout.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { listWikiMarkdownFiles } from "./lib/brain-wiki.js";
import { findPlaceholderLine, stripFrontmatter } from "./lib/wiki-update-guard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VAULT_ROOT = requireVaultPath();
const WIKI_DIR_NAME = process.env.BRAIN_WIKI_DIR_NAME || "📒 Wiki";
const DEFAULT_MIN_BODY_CHARS = 150;

function resolveMinBodyChars() {
  const idx = process.argv.indexOf("--min-body-chars");
  if (idx >= 0 && process.argv[idx + 1]) {
    const n = Number(process.argv[idx + 1]);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  const raw = process.env.WIKI_AUDIT_MIN_BODY_CHARS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return DEFAULT_MIN_BODY_CHARS;
}

function collapseWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function bodyLength(md) {
  return collapseWhitespace(stripFrontmatter(md)).length;
}

function padRight(text, width) {
  const s = String(text);
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(text, max) {
  const s = String(text || "");
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function subdirFromRel(relFromWiki) {
  return relFromWiki.split("/")[0] || "unknown";
}

function main() {
  const minBodyChars = resolveMinBodyChars();

  if (!fs.existsSync(VAULT_ROOT)) {
    console.error(`Vault no encontrado: ${VAULT_ROOT}`);
    process.exit(0);
  }

  const wikiRoot = path.join(VAULT_ROOT, WIKI_DIR_NAME);
  if (!fs.existsSync(wikiRoot)) {
    console.error(`Wiki no encontrada: ${wikiRoot}`);
    process.exit(0);
  }

  const pages = listWikiMarkdownFiles(VAULT_ROOT, WIKI_DIR_NAME).sort((a, b) =>
    a.relFromWiki.localeCompare(b.relFromWiki)
  );

  const findings = [];

  for (const page of pages) {
    let raw;
    try {
      raw = fs.readFileSync(page.fullPath, "utf8");
    } catch (err) {
      findings.push({
        filename: page.relFromWiki,
        subdir: subdirFromRel(page.relFromWiki),
        flag: "UNREADABLE",
        detail: err.message.slice(0, 80)
      });
      continue;
    }

    const body = stripFrontmatter(raw);
    const placeholderLine = findPlaceholderLine(body);
    if (placeholderLine) {
      findings.push({
        filename: page.relFromWiki,
        subdir: subdirFromRel(page.relFromWiki),
        flag: "PLACEHOLDER",
        detail: placeholderLine
      });
    }

    const len = collapseWhitespace(body).length;
    if (len < minBodyChars) {
      findings.push({
        filename: page.relFromWiki,
        subdir: subdirFromRel(page.relFromWiki),
        flag: "SHORT",
        detail: `${len} chars (threshold ${minBodyChars})`
      });
    }
  }

  console.log(`Wiki audit: ${wikiRoot}`);
  console.log(`Min body chars (SHORT): ${minBodyChars}`);
  console.log("");

  if (findings.length === 0) {
    console.log("No flagged pages.");
  } else {
    const colFile = 44;
    const colFlag = 12;
    const colDetail = 72;
    console.log(
      `${padRight("filename", colFile)}${padRight("flag", colFlag)}detail`
    );
    console.log("-".repeat(colFile + colFlag + colDetail));

    for (const row of findings) {
      console.log(
        `${padRight(row.filename, colFile)}${padRight(row.flag, colFlag)}${truncate(row.detail, colDetail)}`
      );
    }
  }

  const placeholderCount = findings.filter((f) => f.flag === "PLACEHOLDER").length;
  const shortCount = findings.filter((f) => f.flag === "SHORT").length;
  const unreadableCount = findings.filter((f) => f.flag === "UNREADABLE").length;
  const flaggedPages = new Set(findings.map((f) => f.filename)).size;

  console.log("");
  console.log(`Scanned: ${pages.length} page(s)`);
  console.log(
    `Flagged: ${flaggedPages} page(s), ${findings.length} finding(s) ` +
      `(PLACEHOLDER=${placeholderCount}, SHORT=${shortCount}` +
      (unreadableCount ? `, UNREADABLE=${unreadableCount}` : "") +
      ")"
  );

  process.exit(0);
}

main();
