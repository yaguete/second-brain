#!/usr/bin/env node

/**
 * Ejecuta en orden: synthesize-wiki → detect:vault (solo informe) → ingest:brain
 *
 * El snapshot del vault lo escribe synthesize-wiki (excluye fuentes fallidas y
 * ficheros iCloud no legibles que sean nuevos). detect:vault en este pipeline
 * no pisa ese estado: si lo hiciera, fuentes nunca sintetizadas quedarían
 * checkpointadas y el siguiente run no las vería.
 *
 * Uso:
 *   npm run sync:wiki
 *   npm run sync:wiki -- --dry-run
 *   npm run sync:wiki -- --analysis-only
 *   npm run sync:wiki -- --file "ruta/nota.md"
 *   npm run sync:wiki -- --replace-all   (solo a ingest:brain; útil primera carga)
 *
 * Flags:
 *   --dry-run       Se pasa a los tres scripts (synthesize no escribe ni llama API;
 *                   detect no escribe el JSON de estado en el vault; ingest no sube chunks).
 *   --replace-all   Solo ingest:brain (no se pasa a synthesize/detect).
 *   --replace       Solo ingest:brain.
 * Cualquier otro argumento se reenvía solo a synthesize-wiki.js
 */

import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const ENV_FILE = path.join(REPO_ROOT, ".env");

const argv = process.argv.slice(2);
const dryAll = argv.includes("--dry-run");
const replaceAll = argv.includes("--replace-all");
const replaceEach = argv.includes("--replace");

const synthesizeArgs = [
  ...argv.filter((a) => a !== "--replace-all" && a !== "--replace"),
  "--skip-ingest"
];
const detectArgs = dryAll ? ["--dry-run"] : [];
const ingestArgs = [
  ...(dryAll ? ["--dry-run"] : []),
  ...(replaceAll ? ["--replace-all"] : []),
  ...(replaceEach ? ["--replace"] : []),
  "--prune"
];

function runStep(label, scriptRelative, extraArgs, env = process.env) {
  console.log(`\n── ${label} ──\n`);
  const scriptPath = path.join(REPO_ROOT, scriptRelative);
  const r = spawnSync(
    process.execPath,
    ["--env-file", ENV_FILE, scriptPath, ...extraArgs],
    { cwd: REPO_ROOT, stdio: "inherit", env: { ...env, SYNC_WIKI: "1" } }
  );
  if (r.status !== 0) {
    console.error(`\nPipeline detenido: ${label} salió con código ${r.status ?? "?"}.`);
    process.exit(r.status ?? 1);
  }
}

console.log("Pipeline wiki: synthesize → detect:vault → ingest:brain");

runStep("1/3 synthesize-wiki", "pipeline/synthesize-wiki.js", synthesizeArgs);
runStep("2/3 detect-vault", "pipeline/detect-vault-changes.js", detectArgs);
runStep("3/3 ingest-brain", "pipeline/ingest-brain.js", ingestArgs);

console.log("\nPipeline wiki terminado.\n");
