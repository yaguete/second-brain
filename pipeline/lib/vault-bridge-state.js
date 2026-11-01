/**
 * Rutas del estado del pipeline (hashes del vault + ingest brain) dentro del vault
 * para que el vault lo sincronice entre máquinas. No hay fallback a la raíz del repo.
 *
 * Override opcional:
 *   VAULT_STATE_FILE — ruta absoluta al JSON de escaneo del vault
 *   BRAIN_INGEST_STATE_FILE — ruta absoluta al estado de ingest:brain
 *   WIKI_ALERTS_STATE_FILE — ruta absoluta al estado de alertas de synthesize:wiki
 */

import fs from "fs";
import path from "path";

const VAULT_STATE_BASENAME = ".second-brain-vault-state.json";
const BRAIN_INGEST_BASENAME = ".second-brain-brain-ingest-state.json";
const WIKI_ALERTS_BASENAME = ".second-brain-wiki-alerts.json";

/** @param {string} vaultRoot @param {string} [_repoRoot] */
export function vaultStatePaths(vaultRoot, _repoRoot) {
  const canonical = process.env.VAULT_STATE_FILE
    ? path.resolve(process.env.VAULT_STATE_FILE)
    : path.join(vaultRoot, VAULT_STATE_BASENAME);
  return { canonical, legacy: canonical };
}

/** @param {string} vaultRoot @param {string} [_repoRoot] */
export function brainIngestStatePaths(vaultRoot, _repoRoot) {
  const canonical = process.env.BRAIN_INGEST_STATE_FILE
    ? path.resolve(process.env.BRAIN_INGEST_STATE_FILE)
    : path.join(vaultRoot, BRAIN_INGEST_BASENAME);
  return { canonical, legacy: canonical };
}

/**
 * Estado de alertas pendientes de synthesize:wiki. Sin legacy: nace con el fichero
 * canónico dentro del vault (misma convención `.second-brain-*.json`).
 * @param {string} vaultRoot
 */
export function wikiAlertsStatePaths(vaultRoot) {
  const canonical = process.env.WIKI_ALERTS_STATE_FILE
    ? path.resolve(process.env.WIKI_ALERTS_STATE_FILE)
    : path.join(vaultRoot, WIKI_ALERTS_BASENAME);
  return { canonical, legacy: canonical };
}

/**
 * @param {string} canonical
 * @param {string} legacy
 * @param {() => unknown} empty
 * @returns {{ data: unknown, writePath: string }}
 */
export function loadJsonState(canonical, legacy, empty) {
  const tryRead = (p) => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };
  if (fs.existsSync(canonical)) {
    const data = tryRead(canonical);
    if (data != null) return { data, writePath: canonical };
  }
  if (fs.existsSync(legacy)) {
    const data = tryRead(legacy);
    if (data != null) return { data, writePath: canonical };
  }
  return { data: empty(), writePath: canonical };
}

/** @param {string} writePath @param {unknown} obj */
export function saveJsonState(writePath, obj) {
  fs.mkdirSync(path.dirname(writePath), { recursive: true });
  fs.writeFileSync(writePath, JSON.stringify(obj, null, 2), "utf8");
}
