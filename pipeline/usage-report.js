#!/usr/bin/env node
/**
 * Agrega el ledger JSONL de LLM usage por step, model y día.
 * Uso: npm run usage:report [-- --days=7] [-- --step=analysis]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getLedgerPath } from "../bridge/src/shared/llm-usage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ledgerPath = process.env.LLM_USAGE_LOG || getLedgerPath() || path.join(__dirname, "..", ".llm-usage.jsonl");

const daysArg = process.argv.find((a) => a.startsWith("--days="));
const DAYS = daysArg ? Number(daysArg.split("=")[1]) : 30;
const stepFilter = process.argv.find((a) => a.startsWith("--step="))?.split("=")[1];

if (!fs.existsSync(ledgerPath)) {
  console.log(`No hay ledger en ${ledgerPath}`);
  process.exit(0);
}

const cutoff = Date.now() - DAYS * 86400000;
const rows = fs
  .readFileSync(ledgerPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean)
  .filter((r) => new Date(r.ts).getTime() >= cutoff)
  .filter((r) => !stepFilter || String(r.step).startsWith(stepFilter));

/** @type {Map<string, object>} */
const byStep = new Map();
/** @type {Map<string, object>} */
const byModel = new Map();
/** @type {Map<string, object>} */
const byDay = new Map();

function bump(map, key, r) {
  const cur = map.get(key) || {
    calls: 0,
    prompt: 0,
    cached: 0,
    miss: 0,
    completion: 0,
    reasoning: 0,
    cost: 0
  };
  cur.calls += 1;
  cur.prompt += r.prompt || 0;
  cur.cached += r.cached || 0;
  cur.miss += r.miss || 0;
  cur.completion += r.completion || 0;
  cur.reasoning += r.reasoning || 0;
  cur.cost += r.cost_usd || 0;
  map.set(key, cur);
}

for (const r of rows) {
  bump(byStep, r.step || "unknown", r);
  bump(byModel, r.model || "unknown", r);
  bump(byDay, (r.ts || "").slice(0, 10), r);
}

function printTable(title, map) {
  console.log(`\n=== ${title} ===`);
  console.log(
    "key".padEnd(28) +
      "calls".padStart(7) +
      "prompt".padStart(10) +
      "cached".padStart(10) +
      "hit%".padStart(7) +
      "out".padStart(9) +
      "reason".padStart(9) +
      "cost$".padStart(10)
  );
  for (const [key, v] of [...map.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
    const hit = v.prompt ? ((v.cached / v.prompt) * 100).toFixed(1) : "0.0";
    console.log(
      String(key).slice(0, 28).padEnd(28) +
        String(v.calls).padStart(7) +
        String(v.prompt).padStart(10) +
        String(v.cached).padStart(10) +
        hit.padStart(7) +
        String(v.completion).padStart(9) +
        String(v.reasoning).padStart(9) +
        v.cost.toFixed(4).padStart(10)
    );
  }
}

console.log(`Ledger: ${ledgerPath}`);
console.log(`Filas (últimos ${DAYS} días${stepFilter ? `, step=${stepFilter}` : ""}): ${rows.length}`);
printTable("Por step", byStep);
printTable("Por model", byModel);
printTable("Por día", byDay);

const totalCost = rows.reduce((s, r) => s + (r.cost_usd || 0), 0);
const totalPrompt = rows.reduce((s, r) => s + (r.prompt || 0), 0);
const totalCached = rows.reduce((s, r) => s + (r.cached || 0), 0);
console.log(
  `\nTOTAL: calls=${rows.length} prompt=${totalPrompt} cached=${totalCached} ` +
    `hit=${totalPrompt ? ((totalCached / totalPrompt) * 100).toFixed(1) : 0}% ~$${totalCost.toFixed(4)}`
);
