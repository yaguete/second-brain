import fs from "fs";
import path from "path";
import crypto from "crypto";

const EXCLUDE_DIR_NAMES = new Set([".obsidian", ".trash", "node_modules", ".git"]);

const SMALL_LINE_THRESHOLD = 50;
const MAX_LINE_DELTA = 3;
const MAX_SIZE_RATIO = 0.03;

export function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Normaliza contenido para comparación estable (CRLF, NFC, trailing WS, saltos finales).
 * @param {Buffer} buf
 * @returns {string}
 */
export function normalizeContent(buf) {
  let s = buf.toString("utf8");
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  s = s.normalize("NFC");
  s = s
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n");
  s = s.replace(/\n+$/, "\n");
  return s;
}

/**
 * @param {string} normalized
 * @returns {{ normalizedHash: string, lineCount: number, normalizedSize: number }}
 */
export function normalizedFingerprint(normalized) {
  const normalizedHash = crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
  const lineCount = normalized.length === 0 ? 0 : normalized.split("\n").length;
  const normalizedSize = Buffer.byteLength(normalized, "utf8");
  return { normalizedHash, lineCount, normalizedSize };
}

/**
 * Heurística conservadora: sin stats previas o archivos pequeños -> siempre significativo.
 * @param {Record<string, unknown> | undefined} prevEntry
 * @param {{ lineCount: number, normalizedSize: number }} currEntry
 * @returns {"significant" | "low_significance"}
 */
export function assessSignificance(prevEntry, currEntry) {
  if (!prevEntry || typeof prevEntry.normalizedHash !== "string") {
    return "significant";
  }
  if (typeof prevEntry.lineCount !== "number" || typeof prevEntry.normalizedSize !== "number") {
    return "significant";
  }
  const prevLines = prevEntry.lineCount;
  const currLines = currEntry.lineCount;
  if (prevLines < SMALL_LINE_THRESHOLD && currLines < SMALL_LINE_THRESHOLD) {
    return "significant";
  }
  const lineDelta = Math.abs(currLines - prevLines);
  const prevSize = prevEntry.normalizedSize;
  const currSize = currEntry.normalizedSize;
  const maxSize = Math.max(prevSize, currSize, 1);
  const sizeRatio = Math.abs(currSize - prevSize) / maxSize;
  if (lineDelta <= MAX_LINE_DELTA && sizeRatio < MAX_SIZE_RATIO) {
    return "low_significance";
  }
  return "significant";
}

/** Normalize vault-relative paths to NFC so macOS NFD readdir forms compare stably. */
export function normalizePathKey(p) {
  return String(p || "").normalize("NFC");
}

export function walkMarkdownFiles(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (EXCLUDE_DIR_NAMES.has(e.name)) continue;
      walkMarkdownFiles(full, base, out);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      const rel = normalizePathKey(path.relative(base, full).split(path.sep).join("/"));
      out.push({ fullPath: full, relPath: rel });
    }
  }
  return out;
}

/**
 * Re-key a path→entry map under NFC so legacy NFD state keys compare with walkMarkdownFiles.
 * @template T
 * @param {Record<string, T>} files
 * @returns {Record<string, T>}
 */
export function normalizePathKeyedMap(files) {
  /** @type {Record<string, T>} */
  const out = {};
  for (const [k, v] of Object.entries(files || {})) {
    out[normalizePathKey(k)] = v;
  }
  return out;
}

export function readFileSafe(fullPath) {
  try {
    const buf = fs.readFileSync(fullPath);
    const st = fs.statSync(fullPath);
    return { ok: true, buf, mtime: st.mtime.toISOString(), size: st.size };
  } catch (e) {
    return { ok: false, error: e.code || e.message };
  }
}

/**
 * @param {string} vaultRoot
 * @param {Record<string, { hash?: string, normalizedHash?: string, lineCount?: number, normalizedSize?: number, size?: number, mtime?: string }>} prevFiles
 */
export function computeVaultDiff(vaultRoot, prevFiles) {
  const prevNormalized = normalizePathKeyedMap(prevFiles || {});
  const prevPaths = new Set(Object.keys(prevNormalized));
  const mdList = walkMarkdownFiles(vaultRoot);
  /** @type {Record<string, { hash: string, size: number, mtime: string, normalizedHash: string, lineCount: number, normalizedSize: number }>} */
  const current = {};
  const icloudPending = [];

  for (const { fullPath, relPath } of mdList) {
    const r = readFileSafe(fullPath);
    if (!r.ok) {
      icloudPending.push({ path: relPath, error: r.error });
      continue;
    }
    const normalized = normalizeContent(r.buf);
    const { normalizedHash, lineCount, normalizedSize } = normalizedFingerprint(normalized);
    current[relPath] = {
      hash: sha256(r.buf),
      size: r.size,
      mtime: r.mtime,
      normalizedHash,
      lineCount,
      normalizedSize
    };
  }

  const currPaths = new Set(Object.keys(current));
  const hashToPrevPaths = new Map();
  for (const p of prevPaths) {
    const h = prevNormalized[p]?.hash;
    if (!h) continue;
    if (!hashToPrevPaths.has(h)) hashToPrevPaths.set(h, []);
    hashToPrevPaths.get(h).push(p);
  }

  /** @type {{ from: string, to: string, hash: string }[]} */
  const moved = [];
  const usedPrevForMove = new Set();
  const usedCurrForMove = new Set();

  for (const newPath of currPaths) {
    const h = current[newPath].hash;
    const candidates = hashToPrevPaths.get(h) || [];
    const fromPath = candidates.find((pp) => pp !== newPath && !usedPrevForMove.has(pp));
    if (fromPath && !prevPaths.has(newPath)) {
      moved.push({ from: fromPath, to: newPath, hash: h });
      usedPrevForMove.add(fromPath);
      usedCurrForMove.add(newPath);
    }
  }

  const created = [];
  const modified = [];
  const normalizedOnly = [];
  const lowSignificance = [];
  const unchanged = [];
  const deleted = [];

  for (const p of currPaths) {
    if (usedCurrForMove.has(p)) continue;
    if (!prevPaths.has(p)) {
      created.push(p);
      continue;
    }
    const ph = prevNormalized[p]?.hash;
    const ch = current[p].hash;
    if (ph === ch) {
      unchanged.push(p);
      continue;
    }
    const prevEntry = prevNormalized[p];
    const currEntry = current[p];
    const prevNorm = prevEntry?.normalizedHash;
    if (typeof prevNorm === "string" && currEntry.normalizedHash === prevNorm) {
      normalizedOnly.push(p);
      continue;
    }
    if (assessSignificance(prevEntry, currEntry) === "low_significance") {
      lowSignificance.push(p);
      continue;
    }
    modified.push(p);
  }

  for (const p of prevPaths) {
    if (usedPrevForMove.has(p)) continue;
    if (!currPaths.has(p)) deleted.push(p);
  }

  return {
    current,
    created,
    modified,
    normalizedOnly,
    lowSignificance,
    moved,
    deleted,
    unchanged,
    icloudPending
  };
}

/**
 * Snapshot que escribe synthesize-wiki: ficheros legibles ahora, menos fuentes
 * fallidas. Los pendientes de iCloud que ya estaban en el estado previo conservan
 * el hash antiguo; los que son nuevos no se checkpointan (el siguiente run los
 * verá como created cuando se puedan leer).
 *
 * @param {{
 *   current: Record<string, object>,
 *   prevFiles?: Record<string, object>,
 *   failedPaths?: Iterable<string>,
 *   icloudPending?: Array<{ path: string } | string>
 * }} opts
 */
export function buildNextVaultFiles({
  current,
  prevFiles = {},
  failedPaths = [],
  icloudPending = []
} = {}) {
  const failed = new Set([...failedPaths].map((p) => normalizePathKey(p)));
  const prev = normalizePathKeyedMap(prevFiles || {});
  /** @type {Record<string, object>} */
  const files = {};
  for (const [rel, entry] of Object.entries(current || {})) {
    const key = normalizePathKey(rel);
    if (!failed.has(key)) files[key] = entry;
  }
  for (const item of icloudPending || []) {
    const rel = normalizePathKey(typeof item === "string" ? item : item?.path);
    if (!rel || failed.has(rel) || files[rel]) continue;
    if (prev[rel]) files[rel] = prev[rel];
  }
  return files;
}
