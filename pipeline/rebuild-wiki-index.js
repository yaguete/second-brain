#!/usr/bin/env node

/**
 * Rebuilds 📒 Wiki/index.md deterministically from wiki page frontmatter.
 *
 * Usage:
 *   npm run rebuild:index
 *   npm run rebuild:index -- --dry-run
 *
 * Env:
 *   OBSIDIAN_VAULT_PATH (obligatoria; no hay ruta por defecto)
 *   BRAIN_WIKI_DIR_NAME (default: "📒 Wiki")
 */

import { requireVaultPath } from "./lib/layout.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildWikiIndexMarkdown, WIKI_INDEX_SECTIONS } from "./lib/brain-wiki.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VAULT_ROOT = requireVaultPath();
const WIKI_DIR_NAME = process.env.BRAIN_WIKI_DIR_NAME || "📒 Wiki";
const DRY = process.argv.includes("--dry-run");

function countSectionEntries(markdown, heading) {
  let inSection = false;
  let count = 0;
  for (const line of markdown.split(/\r?\n/)) {
    if (line === `## ${heading}`) {
      inSection = true;
      continue;
    }
    if (inSection && line.startsWith("## ")) break;
    if (inSection && line.startsWith("- [[")) count++;
  }
  return count;
}

function main() {
  const indexPath = path.join(VAULT_ROOT, WIKI_DIR_NAME, "index.md");
  if (!fs.existsSync(indexPath)) {
    console.error(`Falta index.md en ${indexPath}`);
    process.exit(1);
  }

  const markdown = buildWikiIndexMarkdown(VAULT_ROOT, WIKI_DIR_NAME);
  const counts = Object.fromEntries(
    WIKI_INDEX_SECTIONS.map(({ heading }) => [heading, countSectionEntries(markdown, heading)])
  );

  console.log(`Vault: ${VAULT_ROOT}`);
  console.log(`Wiki:  ${WIKI_DIR_NAME}/index.md`);
  for (const [section, n] of Object.entries(counts)) {
    console.log(`  ${section}: ${n} entradas`);
  }

  if (DRY) {
    console.log("\n(dry-run: no se escribe index.md)");
    return;
  }

  fs.writeFileSync(indexPath, markdown, "utf8");
  console.log(`\nEscrito: ${indexPath} (${markdown.length} bytes)`);
}

main();
