/**
 * Alertas de synthesize:wiki para el inbox del vault.
 *
 * El aviso es una foto del ESTADO, no del run: un único fichero canónico
 * `📥 Inbox/⚠ wiki-sync.md` que se reescribe en cada ejecución y se BORRA cuando
 * no queda nada pendiente. El estado vive en `<vault>/.canonical-wiki-wiki-alerts.json`
 * con una entrada por ruta de fuente ({ error, first_seen, last_seen, attempts }).
 *
 * mergePendingAlerts / renderAlertMarkdown son puras (testeables sin fs).
 */

import fs from "fs";
import path from "path";

const CANONICAL_ALERT_BASENAME = "⚠ wiki-sync.md";
const INBOX_CANDIDATES = ["📥 Inbox", "Inbox", "inbox"];

/** Ficheros por día del esquema antiguo: `⚠ wiki-sync-2026-08-07.md`. */
const LEGACY_ALERT_RE = /^⚠ wiki-sync-\d{4}-\d{2}-\d{2}\.md$/;

/** @returns {{ alerts: Record<string, object>, last_run: string | null }} */
export function emptyAlertState() {
  return { alerts: {}, last_run: null };
}

/**
 * Normaliza estados leídos de disco (o vacíos) a la forma canónica.
 * @param {unknown} raw
 */
export function normalizeAlertState(raw) {
  const state = raw && typeof raw === "object" ? raw : {};
  const alerts =
    state.alerts && typeof state.alerts === "object" && !Array.isArray(state.alerts)
      ? state.alerts
      : {};
  return { alerts: { ...alerts }, last_run: state.last_run ?? null };
}

/**
 * Fusiona los fallos duros del run con el estado pendiente.
 *
 * - Las rutas procesadas SIN fallo duro se eliminan (se resolvieron solas).
 * - Las rutas con fallo duro se insertan o actualizan (`attempts++`).
 * - Las rutas no procesadas en este run se quedan como estaban (importante con `--file`).
 *
 * @param {object} state estado previo
 * @param {{ processedPaths?: string[], hardFailures?: Array<{path: string, error: string, pages?: string[]}>, now?: string }} opts
 * @returns {{ alerts: Record<string, object>, last_run: string }}
 */
export function mergePendingAlerts(state, { processedPaths = [], hardFailures = [], now } = {}) {
  const nowIso = now || new Date().toISOString();
  const prev = normalizeAlertState(state).alerts;
  const failuresByPath = new Map();
  for (const f of hardFailures) {
    if (!f?.path) continue;
    const existing = failuresByPath.get(f.path);
    if (existing) {
      existing.errors.push(String(f.error ?? ""));
      for (const p of f.pages || []) existing.pages.add(p);
    } else {
      failuresByPath.set(f.path, {
        errors: [String(f.error ?? "")],
        pages: new Set(f.pages || [])
      });
    }
  }

  const touched = new Set([...processedPaths, ...failuresByPath.keys()]);
  const alerts = {};

  for (const [rel, entry] of Object.entries(prev)) {
    if (!touched.has(rel)) alerts[rel] = entry;
  }

  for (const [rel, failure] of failuresByPath) {
    const before = prev[rel];
    alerts[rel] = {
      error: failure.errors.filter(Boolean).join("; "),
      pages: [...failure.pages],
      first_seen: before?.first_seen || nowIso,
      last_seen: nowIso,
      attempts: Number(before?.attempts || 0) + 1
    };
  }

  return { alerts, last_run: nowIso };
}

/** @param {object} state @returns {number} */
export function pendingAlertCount(state) {
  return pendingAlertPaths(state).length;
}

/** Rutas con fallo duro pendiente; synthesize-wiki las fuerza como targets. */
export function pendingAlertPaths(state) {
  return Object.keys(normalizeAlertState(state).alerts);
}

function shellQuote(rel) {
  return `"${String(rel).replace(/"/g, '\\"')}"`;
}

/**
 * Markdown del aviso del inbox. Cadena vacía si no hay nada pendiente.
 * @param {object} state
 * @param {{ now?: string }} [opts]
 * @returns {string}
 */
export function renderAlertMarkdown(state, { now } = {}) {
  const { alerts } = normalizeAlertState(state);
  const entries = Object.entries(alerts).sort(
    (a, b) => (b[1]?.attempts || 0) - (a[1]?.attempts || 0) || a[0].localeCompare(b[0])
  );
  if (entries.length === 0) return "";

  const nowIso = now || new Date().toISOString();
  const day = nowIso.slice(0, 10);

  const lines = [
    "---",
    `updated: ${day}`,
    "type: wiki-sync-alert",
    `pending: ${entries.length}`,
    "---",
    "",
    "# Wiki sync — fuentes pendientes",
    "",
    `${entries.length} fuente(s) no se pudieron sintetizar. Cada una sigue sin checkpoint, ` +
      "así que se reintentan en cada `sync:wiki`. Este fichero se borra solo cuando todas se resuelven.",
    ""
  ];

  for (const [rel, entry] of entries) {
    const attempts = Number(entry?.attempts || 1);
    const pages = Array.isArray(entry?.pages) ? entry.pages.filter(Boolean) : [];
    lines.push(`## \`${rel}\``);
    lines.push("");
    lines.push(`- **Error**: ${entry?.error || "(sin detalle)"}`);
    lines.push(
      `- **Intentos**: ${attempts} (desde ${String(entry?.first_seen || "?").slice(0, 10)}, ` +
        `último ${String(entry?.last_seen || "?").slice(0, 10)})`
    );
    if (pages.length > 0) {
      lines.push(`- **Páginas afectadas**: ${pages.map((p) => `\`${p}\``).join(", ")}`);
      lines.push(
        `- **Acción**: revisar ${pages.map((p) => `\`${p}\``).join(", ")} en la wiki ` +
          "(¿la reescritura del LLM perdía hechos o metía placeholders?) y reintentar:"
      );
    } else {
      lines.push("- **Acción**: reintentar la fuente y mirar la salida de consola:");
    }
    lines.push("");
    lines.push("```bash");
    lines.push(`npm run synthesize:wiki -- --file ${shellQuote(rel)}`);
    lines.push("```");
    if (attempts >= 3) {
      lines.push("");
      lines.push(
        `> Atascada desde ${String(entry?.first_seen || "?").slice(0, 10)}: si la condensación es ` +
          "deliberada, aplica el cambio a mano o ajusta `WIKI_MIN_FACT_RETENTION` para ese run."
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** @param {string} name @returns {boolean} */
export function isLegacyAlertFilename(name) {
  return LEGACY_ALERT_RE.test(name);
}

/**
 * Localiza (o crea) el inbox del vault.
 * @param {string} vaultRoot
 * @returns {string}
 */
export function resolveInboxDir(vaultRoot) {
  for (const d of INBOX_CANDIDATES) {
    const p = path.join(vaultRoot, d);
    if (fs.existsSync(p)) return p;
  }
  const fallback = path.join(vaultRoot, INBOX_CANDIDATES[0]);
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

/**
 * @param {string} vaultRoot
 * @returns {{ inboxDir: string, canonical: string }}
 */
export function alertFilePaths(vaultRoot) {
  const inboxDir = resolveInboxDir(vaultRoot);
  return { inboxDir, canonical: path.join(inboxDir, CANONICAL_ALERT_BASENAME) };
}

/**
 * Borra los avisos por día del esquema antiguo (sustituidos por el canónico).
 * @param {string} inboxDir
 * @returns {string[]} ficheros borrados
 */
export function cleanupLegacyAlertFiles(inboxDir) {
  const removed = [];
  let names = [];
  try {
    names = fs.readdirSync(inboxDir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!isLegacyAlertFilename(name)) continue;
    try {
      fs.unlinkSync(path.join(inboxDir, name));
      removed.push(name);
    } catch {
      /* ignorado: el aviso no es crítico */
    }
  }
  return removed;
}

/**
 * Escribe o borra el aviso canónico según el estado.
 * @param {string} vaultRoot
 * @param {object} state
 * @param {{ now?: string }} [opts]
 * @returns {{ path: string, action: "written" | "removed" | "none", pending: number }}
 */
export function syncAlertFile(vaultRoot, state, { now } = {}) {
  const { canonical } = alertFilePaths(vaultRoot);
  const markdown = renderAlertMarkdown(state, { now });
  if (markdown) {
    fs.writeFileSync(canonical, markdown, "utf8");
    return { path: canonical, action: "written", pending: pendingAlertCount(state) };
  }
  if (fs.existsSync(canonical)) {
    fs.unlinkSync(canonical);
    return { path: canonical, action: "removed", pending: 0 };
  }
  return { path: canonical, action: "none", pending: 0 };
}
