#!/usr/bin/env node

/**
 * Reparación determinista (sin LLM) de source_vault rotos y back-fill en páginas source.
 *
 * Uso:
 *   npm run repair:wiki-links
 *   npm run repair:wiki-links -- --dry-run
 *
 * Env:
 *   OBSIDIAN_VAULT_PATH
 *   BRAIN_WIKI_DIR_NAME (default: "📒 Wiki")
 *
 * Acciones:
 *   1. Repara source_vault que no resuelven → único match por basename (NFC).
 *   2. Back-fill source_vault SOLO en type:source con exactamente una ruta vault válida.
 *   3. Reporta pares duplicados (type:source que apuntan al mismo vault doc).
 *   4. No fusiona páginas — el merge queda a juicio humano.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { listWikiMarkdownFiles, parseFrontmatter } from "./lib/brain-wiki.js";
import { walkMarkdownFiles, normalizePathKey } from "./lib/vault-diff.js";
import { requireVaultPath } from "./lib/layout.js";
import { extractFacts } from "./lib/wiki-fact-retention.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VAULT_ROOT = requireVaultPath();
const WIKI_DIR_NAME = process.env.BRAIN_WIKI_DIR_NAME || "📒 Wiki";
const WIKI_PREFIX = `${WIKI_DIR_NAME}/`;
const DRY = process.argv.includes("--dry-run");

function existsOnDisk(rel) {
  const nfc = path.join(VAULT_ROOT, normalizePathKey(rel));
  if (fs.existsSync(nfc)) return normalizePathKey(rel);
  const nfd = path.join(VAULT_ROOT, String(rel).normalize("NFD"));
  if (nfd !== nfc && fs.existsSync(nfd)) return normalizePathKey(rel);
  return null;
}

function upsertFrontmatterField(raw, key, value) {
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return raw;
  let fm = raw.slice(3, end);
  const body = raw.slice(end + 4);
  const quoted = `"${String(value).replace(/"/g, '\\"')}"`;
  const re = new RegExp(`^${key}:\\s*.+$`, "m");
  const line = `${key}: ${quoted}`;
  if (re.test(fm)) fm = fm.replace(re, line);
  else fm = `${fm.trimEnd()}\n${line}`;
  return `---\n${fm.trim()}\n---${body.startsWith("\n") ? "" : "\n"}${body}`;
}

function sourcesList(data) {
  const src = data.sources;
  if (Array.isArray(src)) return src.map(String);
  if (src && typeof src === "string" && src.trim()) return [String(src).trim()];
  return [];
}

function isValidVaultSourcePath(rel) {
  if (!rel || typeof rel !== "string") return false;
  const n = normalizePathKey(rel.trim());
  if (!n || n.startsWith(WIKI_PREFIX)) return false;
  if (!n.toLowerCase().endsWith(".md")) return false;
  // Reject bare tags / non-path tokens (no slash and no emoji folder prefix).
  if (!n.includes("/") && !/^[^\w]/.test(n)) return false;
  return Boolean(existsOnDisk(n));
}

function resolveViaBasename(rel, byBase) {
  const base = path.basename(normalizePathKey(rel));
  const cands = byBase.get(base) || [];
  if (cands.length === 1) return cands[0];
  return null;
}

function pageType(data, relFromWiki) {
  if (data.type) return String(data.type).toLowerCase();
  const dir = relFromWiki.split("/")[0];
  if (dir === "entities") return "entity";
  if (dir === "concepts") return "concept";
  if (dir === "synthesis") return "synthesis";
  if (dir === "essays") return "essay";
  return "source";
}

function main() {
  if (!fs.existsSync(VAULT_ROOT)) {
    console.error(`Vault no encontrado: ${VAULT_ROOT}`);
    process.exit(1);
  }

  const vaultFiles = walkMarkdownFiles(VAULT_ROOT).map((f) => f.relPath);
  /** @type {Map<string, string[]>} */
  const byBase = new Map();
  for (const p of vaultFiles) {
    const b = path.basename(p);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(p);
  }

  const wikiFiles = listWikiMarkdownFiles(VAULT_ROOT, WIKI_DIR_NAME);
  const repairs = [];
  const backfills = [];
  const unresolved = [];
  const ambiguous = [];
  const skippedBackfill = [];
  const invalidSourcesEntries = [];

  for (const { fullPath, relFromWiki } of wikiFiles) {
    const raw = fs.readFileSync(fullPath, "utf8");
    const { data } = parseFrontmatter(raw);
    const type = pageType(data, relFromWiki);
    let nextRaw = raw;
    let changed = false;
    let sv = data.source_vault ? normalizePathKey(String(data.source_vault).replace(/^"|"$/g, "")) : null;

    // 1) Repair broken source_vault
    if (sv) {
      if (!existsOnDisk(sv)) {
        const inferred = resolveViaBasename(sv, byBase);
        if (inferred) {
          repairs.push({
            page: relFromWiki,
            from: sv,
            to: inferred,
            inferred: true
          });
          nextRaw = upsertFrontmatterField(nextRaw, "source_vault", inferred);
          sv = inferred;
          changed = true;
        } else {
          const cands = byBase.get(path.basename(sv)) || [];
          if (cands.length > 1) {
            ambiguous.push({ page: relFromWiki, from: sv, candidates: cands });
          } else {
            unresolved.push({ page: relFromWiki, from: sv });
          }
        }
      }
    }

    // 2) Back-fill source_vault only for type:source
    if (type === "source" && !sv) {
      const entries = sourcesList(data);
      const valid = [];
      for (const entry of entries) {
        const n = normalizePathKey(String(entry).trim());
        if (isValidVaultSourcePath(n)) {
          valid.push(existsOnDisk(n) || n);
        } else if (n) {
          const inferred = resolveViaBasename(n, byBase);
          if (inferred && !inferred.startsWith(WIKI_PREFIX)) {
            valid.push(inferred);
            invalidSourcesEntries.push({
              page: relFromWiki,
              entry: n,
              inferred,
              action: "basename_infer"
            });
          } else {
            invalidSourcesEntries.push({
              page: relFromWiki,
              entry: n,
              inferred: null,
              action: "rejected"
            });
          }
        }
      }
      const unique = [...new Set(valid)];
      if (unique.length === 1) {
        backfills.push({
          page: relFromWiki,
          to: unique[0],
          from_sources: entries
        });
        nextRaw = upsertFrontmatterField(nextRaw, "source_vault", unique[0]);
        sv = unique[0];
        changed = true;
      } else if (unique.length > 1) {
        skippedBackfill.push({
          page: relFromWiki,
          reason: "multiple_valid_sources",
          paths: unique
        });
      } else if (entries.length > 0) {
        skippedBackfill.push({
          page: relFromWiki,
          reason: "no_resolvable_sources",
          entries
        });
      }
    }

    if (changed && !DRY) {
      fs.writeFileSync(fullPath, nextRaw, "utf8");
    }
  }

  // 3) Duplicate scan — type:source only, after repairs/backfills
  /** @type {Map<string, Array<{page:string, chars:number, updated:string|null, facts:number}>>} */
  const bySourceVault = new Map();
  for (const { fullPath, relFromWiki } of wikiFiles) {
    const raw = fs.readFileSync(fullPath, "utf8");
    // Re-read if we would have written; in dry-run simulate from report.
    let effective = raw;
    if (DRY) {
      const repair = repairs.find((r) => r.page === relFromWiki);
      const bf = backfills.find((b) => b.page === relFromWiki);
      if (repair) effective = upsertFrontmatterField(effective, "source_vault", repair.to);
      if (bf) effective = upsertFrontmatterField(effective, "source_vault", bf.to);
    }
    const { data } = parseFrontmatter(effective);
    if (pageType(data, relFromWiki) !== "source") continue;
    const sv = data.source_vault
      ? normalizePathKey(String(data.source_vault).replace(/^"|"$/g, ""))
      : null;
    if (!sv) continue;
    if (!bySourceVault.has(sv)) bySourceVault.set(sv, []);
    bySourceVault.get(sv).push({
      page: relFromWiki,
      chars: effective.length,
      updated: data.updated ? String(data.updated) : null,
      facts: extractFacts(effective).size
    });
  }

  const duplicates = [...bySourceVault.entries()]
    .filter(([, pages]) => pages.length > 1)
    .sort((a, b) => a[0].localeCompare(b[0], "en"));

  const day = new Date().toISOString().slice(0, 10);
  const reportDir = path.join(VAULT_ROOT, "📥 Inbox");
  const reportPath = path.join(reportDir, `wiki-link-repair-${day}.md`);

  const reportLines = [
    "---",
    `date: ${day}`,
    `dry_run: ${DRY}`,
    "---",
    "",
    `# Wiki link repair ${day}`,
    "",
    DRY ? "_Dry-run: no files were written._" : "_Applied to vault._",
    "",
    `## Summary`,
    "",
    `- Repaired source_vault: **${repairs.length}**`,
    `- Back-filled source_vault (type:source): **${backfills.length}**`,
    `- Unresolved source_vault: **${unresolved.length}**`,
    `- Ambiguous basename matches: **${ambiguous.length}**`,
    `- Skipped back-fill: **${skippedBackfill.length}**`,
    `- Duplicate source pairs (type:source): **${duplicates.length}**`,
    "",
    "## Repairs (broken → unique basename)",
    ""
  ];

  for (const r of repairs) {
    reportLines.push(`- \`${r.page}\``);
    reportLines.push(`  - from: \`${r.from}\``);
    reportLines.push(`  - to: \`${r.to}\`${r.inferred ? " _(inferred)_" : ""}`);
  }
  if (repairs.length === 0) reportLines.push("_None._");

  reportLines.push("", "## Back-fills (type:source only)", "");
  for (const b of backfills) {
    reportLines.push(`- \`${b.page}\` → \`${b.to}\``);
  }
  if (backfills.length === 0) reportLines.push("_None._");

  reportLines.push("", "## Unresolved", "");
  for (const u of unresolved) reportLines.push(`- \`${u.page}\` ← \`${u.from}\``);
  if (unresolved.length === 0) reportLines.push("_None._");

  reportLines.push("", "## Ambiguous", "");
  for (const a of ambiguous) {
    reportLines.push(`- \`${a.page}\` ← \`${a.from}\``);
    for (const c of a.candidates) reportLines.push(`  - candidate: \`${c}\``);
  }
  if (ambiguous.length === 0) reportLines.push("_None._");

  reportLines.push("", "## Skipped back-fill", "");
  for (const s of skippedBackfill) {
    reportLines.push(`- \`${s.page}\` (${s.reason})`);
    if (s.paths) for (const p of s.paths) reportLines.push(`  - \`${p}\``);
    if (s.entries) for (const e of s.entries) reportLines.push(`  - entry: \`${e}\``);
  }
  if (skippedBackfill.length === 0) reportLines.push("_None._");

  reportLines.push("", "## Duplicate source pages (no merge — review manually)", "");
  for (const [sv, pages] of duplicates) {
    reportLines.push(`### \`${sv}\``);
    for (const p of pages) {
      reportLines.push(
        `- \`${p.page}\` — ${p.chars.toLocaleString()} chars, updated=${p.updated || "?"}, facts=${p.facts}`
      );
    }
    reportLines.push("");
  }
  if (duplicates.length === 0) reportLines.push("_None._", "");

  reportLines.push("## Invalid / inferred sources: entries", "");
  const rejected = invalidSourcesEntries.filter((e) => e.action === "rejected").slice(0, 40);
  const inferred = invalidSourcesEntries.filter((e) => e.action === "basename_infer").slice(0, 40);
  reportLines.push(`Rejected (sample ≤40 of ${invalidSourcesEntries.filter((e) => e.action === "rejected").length}):`);
  for (const e of rejected) reportLines.push(`- \`${e.page}\`: \`${e.entry}\``);
  reportLines.push("", `Inferred via basename (sample ≤40 of ${invalidSourcesEntries.filter((e) => e.action === "basename_infer").length}):`);
  for (const e of inferred) reportLines.push(`- \`${e.page}\`: \`${e.entry}\` → \`${e.inferred}\``);

  const reportMd = `${reportLines.join("\n").trimEnd()}\n`;

  console.log(`Vault: ${VAULT_ROOT}`);
  console.log(`Mode: ${DRY ? "dry-run" : "write"}`);
  console.log(`Repairs: ${repairs.length}`);
  console.log(`Back-fills: ${backfills.length}`);
  console.log(`Unresolved: ${unresolved.length}`);
  console.log(`Ambiguous: ${ambiguous.length}`);
  console.log(`Skipped back-fill: ${skippedBackfill.length}`);
  console.log(`Duplicate source pairs: ${duplicates.length}`);

  if (DRY) {
    console.log("\n--- dry-run sample repairs ---");
    for (const r of repairs.slice(0, 10)) {
      console.log(`  ${r.page}`);
      console.log(`    ${r.from}`);
      console.log(`    → ${r.to}`);
    }
    console.log("\n--- dry-run sample backfills ---");
    for (const b of backfills.slice(0, 10)) {
      console.log(`  ${b.page} → ${b.to}`);
    }
  }

  if (!DRY) {
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(reportPath, reportMd, "utf8");
    console.log(`\nReport written: ${reportPath}`);
  } else {
    // Still write report on dry-run so the human can review — into Inbox is fine; Inbox is
    // "immutable" for LLM ingest, but this script is human-facing tooling.
    fs.mkdirSync(reportDir, { recursive: true });
    const dryPath = path.join(reportDir, `wiki-link-repair-${day}-dry-run.md`);
    fs.writeFileSync(dryPath, reportMd, "utf8");
    console.log(`\nDry-run report written: ${dryPath}`);
  }
}

main();
