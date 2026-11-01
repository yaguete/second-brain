#!/usr/bin/env node

/**
 * Regenera páginas source extractivas para docs log/referencia ya ingestados.
 *
 * Uso:
 *   npm run rebuild:extractive
 *   npm run rebuild:extractive -- --dry-run
 *
 * - Clasifica cada source_vault; si es extractive y la retención actual es baja,
 *   reescribe la página canónica (una por vault doc).
 * - Si varios source-* apuntan al mismo vault doc, conserva el más reciente/
 *   largo como canónico y borra los duplicados supersedidos.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { listWikiMarkdownFiles, parseFrontmatter, buildWikiIndexMarkdown } from "./lib/brain-wiki.js";
import { normalizePathKey } from "./lib/vault-diff.js";
import { classifySourceDoc } from "./lib/wiki-source-classify.js";
import { buildExtractiveSourcePage } from "./lib/wiki-extractive-source.js";
import { factRetention } from "./lib/wiki-fact-retention.js";
import { extractDateFromFilename } from "../bridge/src/shared/brain-date.js";
import { requireVaultPath } from "./lib/layout.js";

const VAULT_ROOT = requireVaultPath();
const WIKI_DIR_NAME = process.env.BRAIN_WIKI_DIR_NAME || "📒 Wiki";
const DRY = process.argv.includes("--dry-run");

function existsRel(rel) {
  const nfc = path.join(VAULT_ROOT, normalizePathKey(rel));
  if (fs.existsSync(nfc)) return nfc;
  const nfd = path.join(VAULT_ROOT, String(rel).normalize("NFD"));
  if (nfd !== nfc && fs.existsSync(nfd)) return nfd;
  return null;
}

function main() {
  const wikiFiles = listWikiMarkdownFiles(VAULT_ROOT, WIKI_DIR_NAME);
  /** @type {Map<string, Array<{relFromWiki:string, fullPath:string, raw:string, data:object, chars:number}>>} */
  const byVault = new Map();

  for (const { fullPath, relFromWiki } of wikiFiles) {
    if (!relFromWiki.startsWith("sources/")) continue;
    const raw = fs.readFileSync(fullPath, "utf8");
    const { data } = parseFrontmatter(raw);
    if (String(data.type || "source").toLowerCase() !== "source") continue;
    const sv = data.source_vault
      ? normalizePathKey(String(data.source_vault).replace(/^"|"$/g, ""))
      : null;
    if (!sv) continue;
    if (!byVault.has(sv)) byVault.set(sv, []);
    byVault.get(sv).push({
      relFromWiki,
      fullPath,
      raw,
      data,
      chars: raw.length
    });
  }

  const rewritten = [];
  const deleted = [];
  const skipped = [];

  for (const [sv, pages] of [...byVault.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const fullSrc = existsRel(sv);
    if (!fullSrc) {
      skipped.push({ sv, reason: "source_missing" });
      continue;
    }
    const srcContent = fs.readFileSync(fullSrc, "utf8");

    // Prefer the longest page as "existing" for the retention guard, then classify.
    pages.sort((a, b) => {
      const ua = String(a.data.updated || "");
      const ub = String(b.data.updated || "");
      if (ua !== ub) return ub.localeCompare(ua);
      return b.chars - a.chars;
    });
    const canonical = pages[0];
    const classification = classifySourceDoc(sv, srcContent, {
      // Force rebuild of low-fidelity pages: pass worst page so high-retention
      // duplicates do not suppress a needed rebuild of the group.
      existingSourcePage: null
    });

    if (!classification.extractive) {
      skipped.push({
        sv,
        reason: classification.reason,
        pages: pages.map((p) => p.relFromWiki)
      });
      continue;
    }

    // Extra guard from the plan: skip if the best existing page already retains ≥85%.
    let bestRetention = 0;
    for (const p of pages) {
      const { retention, total } = factRetention(srcContent, p.raw);
      if (total >= 5) bestRetention = Math.max(bestRetention, retention);
    }
    const minRet = Number(process.env.WIKI_EXTRACTIVE_MIN_EXISTING_RETENTION ?? 0.85);
    if (bestRetention >= minRet) {
      skipped.push({
        sv,
        reason: `existing_retention_ok (${(bestRetention * 100).toFixed(1)}%)`,
        pages: pages.map((p) => p.relFromWiki)
      });
      continue;
    }

    const title =
      (canonical.data.title && String(canonical.data.title)) ||
      path.basename(sv, ".md");
    const filename = path.basename(canonical.fullPath);
    const eventDate =
      (canonical.data.event_date && String(canonical.data.event_date)) ||
      extractDateFromFilename(sv);
    const newMd = buildExtractiveSourcePage({
      sourceRel: sv,
      sourceContent: srcContent,
      filename,
      title,
      eventDate,
      tags: Array.isArray(canonical.data.tags) ? canonical.data.tags.map(String) : []
    });

    const beforeRet = factRetention(srcContent, canonical.raw).retention;
    const afterRet = factRetention(srcContent, newMd).retention;

    if (afterRet + 0.02 < beforeRet) {
      skipped.push({
        sv,
        reason: `extractive_would_regress (${(beforeRet * 100).toFixed(1)}% → ${(afterRet * 100).toFixed(1)}%)`,
        pages: pages.map((p) => p.relFromWiki)
      });
      continue;
    }

    rewritten.push({
      sv,
      page: canonical.relFromWiki,
      before: beforeRet,
      after: afterRet,
      deleted_dupes: pages.slice(1).map((p) => p.relFromWiki)
    });

    if (!DRY) {
      fs.writeFileSync(canonical.fullPath, newMd, "utf8");
      for (const dup of pages.slice(1)) {
        fs.unlinkSync(dup.fullPath);
        deleted.push(dup.relFromWiki);
      }
    } else {
      for (const dup of pages.slice(1)) deleted.push(dup.relFromWiki);
    }
  }

  if (!DRY) {
    const indexPath = path.join(VAULT_ROOT, WIKI_DIR_NAME, "index.md");
    fs.writeFileSync(indexPath, buildWikiIndexMarkdown(VAULT_ROOT, WIKI_DIR_NAME), "utf8");
  }

  console.log(`Vault: ${VAULT_ROOT}`);
  console.log(`Mode: ${DRY ? "dry-run" : "write"}`);
  console.log(`Rewritten extractive: ${rewritten.length}`);
  console.log(`Deleted duplicates: ${deleted.length}`);
  console.log(`Skipped: ${skipped.length}`);
  console.log("\nRewrites:");
  for (const r of rewritten) {
    console.log(
      `  ${(r.before * 100).toFixed(1)}% → ${(r.after * 100).toFixed(1)}%  ${r.page} ← ${r.sv}` +
        (r.deleted_dupes.length ? ` (drop ${r.deleted_dupes.length} dupes)` : "")
    );
  }
  if (deleted.length) {
    console.log("\nDuplicates to remove:");
    for (const d of deleted) console.log(`  - ${d}`);
  }
}

main();
