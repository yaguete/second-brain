#!/usr/bin/env node
/**
 * Audita fidelidad factual de páginas wiki vs source_vault.
 * Uso: npm run audit:fidelity [-- --min-facts=5] [-- --limit=50]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { listWikiMarkdownFiles, parseFrontmatter, buildWikiTitleIndex } from "./lib/brain-wiki.js";
import { factRetention } from "./lib/wiki-fact-retention.js";
import { requireVaultPath } from "./lib/layout.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAULT_ROOT = requireVaultPath();
const WIKI_DIR_NAME = process.env.BRAIN_WIKI_DIR_NAME || "📒 Wiki";

const minFacts = Number(process.argv.find((a) => a.startsWith("--min-facts="))?.split("=")[1] || 5);
const limit = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] || 0);

const titleIndex = buildWikiTitleIndex(VAULT_ROOT, WIKI_DIR_NAME);
const results = [];

for (const { fullPath, relFromWiki } of listWikiMarkdownFiles(VAULT_ROOT, WIKI_DIR_NAME)) {
  const page = fs.readFileSync(fullPath, "utf8");
  const { data } = parseFrontmatter(page);
  const sourceVault = data.source_vault
    ? String(data.source_vault).replace(/^"|"$/g, "").normalize("NFC")
    : null;
  if (!sourceVault) continue;
  let srcPath = path.join(VAULT_ROOT, sourceVault);
  if (!fs.existsSync(srcPath)) {
    const nfd = path.join(VAULT_ROOT, sourceVault.normalize("NFD"));
    if (nfd !== srcPath && fs.existsSync(nfd)) srcPath = nfd;
    else continue;
  }
  const src = fs.readFileSync(srcPath, "utf8");
  const { retention, total, lost } = factRetention(src, page, { titleIndex: titleIndex.byTitle });
  if (total < minFacts) continue;
  results.push({
    page: relFromWiki,
    source: sourceVault,
    retention,
    total,
    lost: lost.length,
    sample_lost: lost.slice(0, 5).map((f) => f.value)
  });
}

results.sort((a, b) => a.retention - b.retention);
const shown = limit > 0 ? results.slice(0, limit) : results;

console.log(`Vault: ${VAULT_ROOT}`);
console.log(`Páginas auditables (≥${minFacts} hechos, con source_vault): ${results.length}`);
if (results.length === 0) {
  process.exit(0);
}
const avg = results.reduce((s, r) => s + r.retention, 0) / results.length;
const min = results[0].retention;
console.log(`Retención media: ${(avg * 100).toFixed(1)}% | mínima: ${(min * 100).toFixed(1)}%\n`);
console.log("Peores primero:");
for (const r of shown) {
  console.log(
    `  ${(r.retention * 100).toFixed(1)}% (${r.lost}/${r.total}) ${r.page} ← ${r.source}` +
      (r.sample_lost.length ? ` | lost: ${r.sample_lost.join(", ")}` : "")
  );
}

const outDir = path.join(VAULT_ROOT, "📥 Inbox");
if (process.env.AUDIT_FIDELITY_INBOX === "1" && fs.existsSync(path.dirname(outDir))) {
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const out = path.join(outDir, `audit-fidelity-${day}.md`);
    const md = [
      `---`,
      `date: ${day}`,
      `---`,
      `# Audit fidelity ${day}`,
      ``,
      `Media ${(avg * 100).toFixed(1)}% · mín ${(min * 100).toFixed(1)}% · n=${results.length}`,
      ``,
      ...shown.slice(0, 30).map(
        (r) =>
          `- **${(r.retention * 100).toFixed(1)}%** \`${r.page}\` ← \`${r.source}\` (lost ${r.lost}/${r.total})`
      ),
      ``
    ].join("\n");
    fs.writeFileSync(out, md, "utf8");
    console.log(`\nEscrito: ${out}`);
  } catch (e) {
    console.warn(`No se pudo escribir inbox: ${e.message}`);
  }
}
