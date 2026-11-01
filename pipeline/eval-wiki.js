#!/usr/bin/env node
/**
 * Eval A/B de synthesize-wiki con snapshot/restore de la wiki + vault state.
 *
 * Uso:
 *   npm run eval:wiki -- --file "🗓️ Daily notes/2026.07.28.md" \
 *     --a "WIKI_SYNTHESIS_MODEL=deepseek-v4-pro" \
 *     --b "WIKI_SYNTHESIS_MODEL=deepseek-v4-flash"
 *
 * Opcional: --sources sources.txt (una ruta relativa por línea)
 */
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { wikiRoot, listWikiMarkdownFiles, buildWikiTitleIndex } from "./lib/brain-wiki.js";
import { factRetention } from "./lib/wiki-fact-retention.js";
import { requireVaultPath } from "./lib/layout.js";
import { vaultStatePaths } from "./lib/vault-bridge-state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const VAULT_ROOT = requireVaultPath();
const WIKI_DIR_NAME = process.env.BRAIN_WIKI_DIR_NAME || "📒 Wiki";
const { canonical: vaultStateFile } = vaultStatePaths(VAULT_ROOT, REPO_ROOT);

function parseAssignments(s) {
  const env = {};
  if (!s) return env;
  for (const part of s.split(/\s+/)) {
    const i = part.indexOf("=");
    if (i > 0) env[part.slice(0, i)] = part.slice(i + 1);
  }
  return env;
}

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) copyRecursive(from, to);
    else fs.copyFileSync(from, to);
  }
}

function snapshot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-eval-"));
  const wiki = wikiRoot(VAULT_ROOT, WIKI_DIR_NAME);
  copyRecursive(wiki, path.join(dir, "wiki"));
  if (fs.existsSync(vaultStateFile)) {
    fs.copyFileSync(vaultStateFile, path.join(dir, "vault-state.json"));
  }
  return dir;
}

function restore(snapDir) {
  const wiki = wikiRoot(VAULT_ROOT, WIKI_DIR_NAME);
  fs.rmSync(wiki, { recursive: true, force: true });
  copyRecursive(path.join(snapDir, "wiki"), wiki);
  const stateSnap = path.join(snapDir, "vault-state.json");
  if (fs.existsSync(stateSnap)) {
    fs.copyFileSync(stateSnap, vaultStateFile);
  }
}

function listPages() {
  const out = new Map();
  for (const { fullPath, relFromWiki } of listWikiMarkdownFiles(VAULT_ROOT, WIKI_DIR_NAME)) {
    out.set(relFromWiki, fs.readFileSync(fullPath, "utf8"));
  }
  return out;
}

function runArm(label, envExtra, files) {
  const ledger = path.join(os.tmpdir(), `llm-usage-eval-${label}-${Date.now()}.jsonl`);
  const before = listPages();
  const env = { ...process.env, ...envExtra, LLM_USAGE_LOG: ledger };
  for (const file of files) {
    const r = spawnSync(
      process.execPath,
      ["--env-file=.env", "scripts/synthesize-wiki.js", "--file", file],
      { cwd: REPO_ROOT, env, encoding: "utf8" }
    );
    console.log(`\n── ${label} / ${file} exit=${r.status} ──`);
    if (r.stderr) process.stderr.write(r.stderr.slice(-2000));
    if (r.stdout) process.stdout.write(r.stdout.slice(-3000));
  }
  const after = listPages();
  const titleIndex = buildWikiTitleIndex(VAULT_ROOT, WIKI_DIR_NAME);
  const retentions = [];
  for (const [rel, afterMd] of after) {
    const beforeMd = before.get(rel);
    if (!beforeMd || beforeMd === afterMd) continue;
    if (!rel.startsWith("entities/") && !rel.startsWith("concepts/") && !rel.startsWith("synthesis/")) {
      continue;
    }
    const { retention, total, lost } = factRetention(beforeMd, afterMd, {
      titleIndex: titleIndex.byTitle
    });
    if (total >= 3) {
      retentions.push({ rel, retention, total, lost: lost.length });
    }
  }
  return { ledger, retentions, stderrHints: "" };
}

const aArg = process.argv.find((a) => a.startsWith("--a="))?.slice(4) || "";
const bArg = process.argv.find((a) => a.startsWith("--b="))?.slice(4) || "";
const fileArgIdx = process.argv.indexOf("--file");
const sourcesArg = process.argv.find((a) => a.startsWith("--sources="))?.split("=")[1];

let files = [];
if (fileArgIdx >= 0 && process.argv[fileArgIdx + 1]) {
  files = [process.argv[fileArgIdx + 1]];
} else if (sourcesArg) {
  files = fs
    .readFileSync(sourcesArg, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
} else {
  console.error("Usa --file <rel> o --sources <file>");
  process.exit(1);
}

console.log(`Eval wiki A/B sobre ${files.length} fuente(s)`);
console.log(`A: ${aArg || "(env actual)"}`);
console.log(`B: ${bArg || "(env actual)"}`);

const snap = snapshot();
try {
  console.log("\n=== Brazo A ===");
  restore(snap);
  const armA = runArm("A", parseAssignments(aArg), files);
  console.log("\n=== Brazo B ===");
  restore(snap);
  const armB = runArm("B", parseAssignments(bArg), files);
  restore(snap);

  function summarize(name, arm) {
    const vals = arm.retentions.map((r) => r.retention);
    const avg = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 1;
    const min = vals.length ? Math.min(...vals) : 1;
    console.log(
      `\n${name}: updates medidos=${vals.length} retention_avg=${(avg * 100).toFixed(2)}% min=${(min * 100).toFixed(2)}%`
    );
    for (const r of arm.retentions.slice(0, 10)) {
      console.log(`  ${(r.retention * 100).toFixed(1)}% ${r.rel} (lost ${r.lost}/${r.total})`);
    }
    console.log(`  ledger: ${arm.ledger}`);
  }
  summarize("A", armA);
  summarize("B", armB);
} finally {
  // vault already restored
  try {
    fs.rmSync(snap, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
