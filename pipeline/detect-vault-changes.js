#!/usr/bin/env node

/**
 * Detecta cambios en el vault de Obsidian comparando hashes SHA-256 del contenido.
 * Útil con iCloud: el mtime no es fiable; el hash sí.
 *
 * Uso:
 *   npm run detect:vault
 *
 * Variables de entorno:
 *   OBSIDIAN_VAULT_PATH - Raíz del vault (obligatorio en prod; default local del plan)
 *   VAULT_STATE_FILE (opcional) - Ruta absoluta al JSON de estado; por defecto
 *     `<vault>/.second-brain-vault-state.json` (sincroniza con iCloud junto al vault).
 *     Si no existe, se lee el legacy `second-brain/.vault-state.json` y las siguientes
 *     escrituras van al fichero dentro del vault.
 *
 * Opciones:
 *   --dry-run       No escribe el fichero de estado
 *   --json          Salida solo JSON al stdout (sin logs humanos); incluye
 *                   summary.normalized_only, summary.low_significance y listas homónimas
 *   --output <file> Escribe el reporte JSON además del estado (default: no)
 */

import { requireVaultPath } from "./lib/layout.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { computeVaultDiff } from "./lib/vault-diff.js";
import { vaultStatePaths, loadJsonState, saveJsonState } from "./lib/vault-bridge-state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const VAULT_ROOT = requireVaultPath();
const { canonical: VAULT_STATE_WRITE, legacy: VAULT_STATE_LEGACY } = vaultStatePaths(
  VAULT_ROOT,
  REPO_ROOT
);

const DRY_RUN = process.argv.includes("--dry-run");
const JSON_ONLY = process.argv.includes("--json");
/** En `sync:wiki`, synthesize-wiki es dueño del snapshot; detect solo informa. */
const SKIP_STATE_WRITE = process.env.SYNC_WIKI === "1";
const outIdx = process.argv.indexOf("--output");
const OUTPUT_REPORT = outIdx >= 0 && process.argv[outIdx + 1] ? path.resolve(process.argv[outIdx + 1]) : null;

function loadState() {
  const { data } = loadJsonState(VAULT_STATE_WRITE, VAULT_STATE_LEGACY, () => ({
    last_run: null,
    files: {}
  }));
  return data && typeof data === "object" ? data : { last_run: null, files: {} };
}

function main() {
  if (!JSON_ONLY && !fs.existsSync(VAULT_ROOT)) {
    console.error(`Error: vault no encontrado: ${VAULT_ROOT}`);
    console.error("Configura OBSIDIAN_VAULT_PATH en .env");
    process.exit(1);
  }

  const prev = loadState();
  const prevFiles = prev.files || {};

  const {
    current,
    created,
    modified,
    normalizedOnly,
    lowSignificance,
    moved,
    deleted,
    unchanged,
    icloudPending
  } = computeVaultDiff(VAULT_ROOT, prevFiles);

  const report = {
    vault_root: VAULT_ROOT,
    scanned_at: new Date().toISOString(),
    summary: {
      created: created.length,
      modified: modified.length,
      normalized_only: normalizedOnly.length,
      low_significance: lowSignificance.length,
      moved: moved.length,
      deleted: deleted.length,
      unchanged: unchanged.length,
      icloud_pending: icloudPending.length
    },
    created,
    modified,
    normalized_only: normalizedOnly,
    low_significance: lowSignificance,
    moved,
    deleted,
    icloud_pending: icloudPending.length ? icloudPending : undefined
  };

  const nextState = {
    last_run: report.scanned_at,
    files: current
  };

  if (!JSON_ONLY) {
    console.log(`Vault: ${VAULT_ROOT}`);
    console.log(`Markdown files: ${Object.keys(current).length + icloudPending.length}`);
    console.log("");
    console.log("Summary:", report.summary);
    if (created.length) console.log("\nCreated:\n" + created.map((p) => `  + ${p}`).join("\n"));
    if (modified.length) console.log("\nModified (significant):\n" + modified.map((p) => `  ~ ${p}`).join("\n"));
    if (normalizedOnly.length) {
      console.log("\nNormalized-only (raw hash changed, content normalized unchanged):\n" + normalizedOnly.map((p) => `  = ${p}`).join("\n"));
    }
    if (lowSignificance.length) {
      console.log("\nLow significance (skipped by synthesize by default):\n" + lowSignificance.map((p) => `  . ${p}`).join("\n"));
    }
    if (moved.length) console.log("\nMoved:\n" + moved.map((m) => `  ${m.from} -> ${m.to}`).join("\n"));
    if (deleted.length) console.log("\nDeleted:\n" + deleted.map((p) => `  - ${p}`).join("\n"));
    if (icloudPending.length) {
      console.log("\niCloud / read errors (skipped):");
      for (const x of icloudPending) console.log(`  ? ${x.path} (${x.error})`);
    }
    console.log("");
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  if (OUTPUT_REPORT) {
    fs.writeFileSync(OUTPUT_REPORT, JSON.stringify(report, null, 2), "utf8");
    if (!JSON_ONLY) console.log(`Report written: ${OUTPUT_REPORT}`);
  }

  if (!DRY_RUN && !SKIP_STATE_WRITE) {
    saveJsonState(VAULT_STATE_WRITE, nextState);
    if (!JSON_ONLY) console.log(`State written: ${VAULT_STATE_WRITE}`);
  } else if (!JSON_ONLY) {
    if (DRY_RUN) console.log("(dry-run: state file not updated)");
    else console.log("SYNC_WIKI=1: snapshot lo gestiona synthesize-wiki; detect no escribe estado.");
  }
}

main();
