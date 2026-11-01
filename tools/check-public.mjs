#!/usr/bin/env node
/**
 * Blocks a public-repo leak before commit.
 * Always applies the committed core. If tools/banned-terms.local.txt exists, applies that too.
 * Soft terms (lines starting with ?) are reported and do not fail the run.
 * Case-sensitive whole words start with "=".
 */
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const SKIP_DIRS = new Set([".git", "node_modules", "coverage"]);
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SECRET_RES = [
  /sk-[A-Za-z0-9]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/
];

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const rel = path.relative(ROOT, full);
    if (rel === "tools/banned-terms.local.txt" || rel === "tools/check-public.mjs" || rel === "PLAN.md") continue;
    if (rel === ".env" || (rel.startsWith(".env.") && rel !== ".env.example")) continue;
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (st.isFile()) out.push(full);
  }
  return out;
}

function herokuAllowed(rel) {
  return rel === "README.md" || rel.startsWith("docs/adr/");
}

function coreHits(rel, line) {
  const hits = [];
  const rules = [
    ["/Users/", line.includes("/Users/")],
    ["iCloud~md~obsidian", line.includes("iCloud~md~obsidian")],
    ["notas_de_yago", line.includes("notas_de_yago")],
    ["herokuapp.com", line.includes("herokuapp.com")],
    ["heroku", /\bheroku\b/i.test(line) && !herokuAllowed(rel)],
    ["yago-bridge", line.includes("yago-bridge")],
    [".yago-bridge-", line.includes(".yago-bridge-")],
    ["uuid", UUID_RE.test(line) && rel !== "package-lock.json"],
    ["secret", SECRET_RES.some((re) => re.test(line))]
  ];
  for (const [id, bad] of rules) if (bad) hits.push(id);
  for (const email of line.match(EMAIL_RE) || []) {
    if (!email.endsWith("@example.com")) hits.push(`email:${email}`);
  }
  return hits;
}

function trackedEnvFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "--", ".env", ".env.*"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l !== ".env.example");
  } catch {
    return [];
  }
}

function loadLocal() {
  const file = path.join(ROOT, "tools/banned-terms.local.txt");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

function localHit(term, line) {
  let soft = false;
  let sensitive = false;
  let body = term;
  if (body.startsWith("?")) {
    soft = true;
    body = body.slice(1);
  }
  if (body.startsWith("=")) {
    sensitive = true;
    body = body.slice(1);
  }
  if (!body) return null;
  let found = false;
  if (sensitive) {
    const re = new RegExp(`\\b${body.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    found = re.test(line);
  } else if (body.includes(" ")) {
    found = line.toLowerCase().includes(body.toLowerCase());
  } else {
    const re = new RegExp(`\\b${body.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    found = re.test(line);
  }
  if (!found) return null;
  return { soft, body };
}

const files = walk(ROOT);
const hard = [];
const soft = [];
const local = loadLocal();

for (const file of files) {
  const rel = path.relative(ROOT, file);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\0")) continue;
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const id of coreHits(rel, line)) {
      hard.push(`${rel}:${i + 1} [${id}]`);
    }
    for (const term of local) {
      const hit = localHit(term, line);
      if (!hit) continue;
      const row = `${rel}:${i + 1} [${hit.body}]`;
      if (hit.soft) soft.push(row);
      else hard.push(row);
    }
  });
}

for (const rel of trackedEnvFiles()) hard.push(`${rel} [tracked-env]`);

if (soft.length) {
  console.log(`check-public: ${soft.length} soft hit(s), review by hand`);
  for (const row of soft.slice(0, 40)) console.log(`  ~ ${row}`);
}
if (hard.length) {
  console.error(`check-public: ${hard.length} blocking hit(s)`);
  for (const row of hard.slice(0, 80)) console.error(`  ${row}`);
  process.exit(1);
}
console.log(`check-public: clean (${files.length} files${local.length ? `, ${local.length} local terms` : ""})`);
