#!/usr/bin/env node
/**
 * Prepara los 1:1 de mañana con Claude Code CLI y escribe los puntos en
 * "## Notas rápidas" de la daily del día del 1:1 (bloque idempotente entre marcadores).
 *
 * Uso:
 *   npm run prep:121                     # 1:1 de mañana (Europe/Madrid)
 *   npm run prep:121 -- --date=2026-09-29
 *   npm run prep:121 -- --dry-run        # imprime, no escribe
 *
 * Env: OBSIDIAN_VAULT_PATH (obligatoria), PREP121_ALLOWED_TOOLS, CLAUDE_BIN, CLAUDE_MODEL, CLAUDE_TIMEOUT_MS.
 * Claude trabaja en solo lectura; la escritura la hace este script.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runClaude } from "../bridge/src/shared/claude-cli.js";
import { DEFAULT_DAILY_NOTES_DIR } from "./lib/monthly.js";
import { findOneOnOnes, upsertPrepBlock, tomorrowIso, dailyFilename, renderTemplate } from "./lib/prep-121.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VAULT_ROOT = process.env.OBSIDIAN_VAULT_PATH?.trim();
const DRY = process.argv.includes("--dry-run");
const dateArg = process.argv.find((a) => a.startsWith("--date="))?.split("=")[1];
const ALLOWED = (process.env.PREP121_ALLOWED_TOOLS || "Read,Grep,Glob,mcp__linear,mcp__claude_ai_Linear")
  .split(",").map((s) => s.trim()).filter(Boolean);

function nowLabel() {
  return new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
  }).format(new Date()).replace(",", " a las");
}

function humanDate(iso) {
  return new Intl.DateTimeFormat("es-ES", {
    timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric"
  }).format(new Date(`${iso}T12:00:00Z`));
}

function writeBlock(dailyPath, body) {
  const fresh = fs.readFileSync(dailyPath, "utf8"); // releer: la daily pudo cambiar mientras Claude trabajaba
  fs.writeFileSync(dailyPath, upsertPrepBlock(fresh, body, { generatedAt: nowLabel() }), "utf8");
}

async function main() {
  if (!VAULT_ROOT || !fs.existsSync(VAULT_ROOT)) {
    console.error(`Vault no encontrado (OBSIDIAN_VAULT_PATH): ${VAULT_ROOT || "(vacía)"}`);
    process.exit(1);
  }
  const date = dateArg || tomorrowIso();
  const file = dailyFilename(date);
  const dailyPath = path.join(VAULT_ROOT, DEFAULT_DAILY_NOTES_DIR, file);
  console.log(`prep:121 — daily ${file}${DRY ? " (dry-run)" : ""}`);

  if (!fs.existsSync(dailyPath)) {
    console.log("No existe la daily; nada que hacer.");
    return;
  }
  const items = findOneOnOnes(fs.readFileSync(dailyPath, "utf8"));
  if (!items.length) {
    console.log("No hay 1:1 pendientes; nada que hacer.");
    return;
  }
  console.log(`1:1 detectados: ${items.map((i) => i.people.join(" + ") || i.line).join(" · ")}`);

  const template = fs.readFileSync(path.join(REPO_ROOT, "pipeline", "prompts", "prep-121.md"), "utf8");
  const prompt = renderTemplate(template, {
    DATE_HUMAN: humanDate(date),
    DAILY_FILE: file,
    ONE_ON_ONES: items.map((i) => `- ${i.line}`).join("\n")
  });

  let body;
  try {
    const res = await runClaude({
      prompt,
      cwd: VAULT_ROOT,
      allowedTools: ALLOWED,
      disallowedTools: ["Bash", "Edit", "Write", "NotebookEdit"]
    });
    body = res.text.trim();
    if (!body) throw new Error("Claude devolvió una respuesta vacía");
    console.log(res.costUsd != null ? `Coste equivalente reportado: ~$${res.costUsd.toFixed(4)} (plan)` : "");
  } catch (e) {
    console.error(`Error de Claude: ${e.message}`);
    body =
      e.kind === "auth"
        ? "⚠️ No se pudo preparar: la sesión de Claude Code en el runner ha caducado. Ejecuta `claude` en ese Mac, vuelve a iniciar sesión y lanza `npm run prep:121`."
        : `⚠️ No se pudo preparar automáticamente (${String(e.message).slice(0, 200)}). Revisa el log del runner.`;
    process.exitCode = 1;
  }

  if (DRY) {
    console.log(`\n${body}\n`);
    return;
  }
  writeBlock(dailyPath, body);
  console.log(`Escrito en ${path.join(DEFAULT_DAILY_NOTES_DIR, file)} → ## Notas rápidas`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
