#!/usr/bin/env node

/**
 * Lee la wiki Obsidian (📒 Wiki), trocea markdown y envía chunks a POST /v1/brain/ingest.
 *
 * Env:
 *   OBSIDIAN_VAULT_PATH
 *   BRAIN_INGEST_STATE_FILE (opcional) — ver scripts/lib/vault-bridge-state.js; por defecto
 *     `<vault>/.canonical-wiki-brain-ingest-state.json` (iCloud con el vault).
 *   BRAIN_WIKI_DIR_NAME (default: "📒 Wiki")
 *   BRIDGE_URL, BRIDGE_API_KEY
 *   BRAIN_INGEST_BATCH_SIZE (default: 20) — chunks por request POST (evita 413 en páginas grandes)
 *   BRAIN_MAX_CHUNKS_PER_PAGE (default: 25) — warning si una página supera este umbral
 *
 * Uso:
 *   npm run ingest:brain
 *   npm run ingest:brain -- --replace-all
 *   npm run ingest:brain -- --replace
 *   npm run ingest:brain -- --prune
 *   npm run ingest:brain -- --dry-run
 */

import { requireVaultPath } from "./lib/layout.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  resolveDocumentDate,
  resolveEventDate
} from "../bridge/src/shared/brain-date.js";
import {
  chunkMarkdown,
  listWikiMarkdownFiles,
  parseFrontmatter,
  sha256
} from "./lib/brain-wiki.js";
import { brainIngestStatePaths, loadJsonState, saveJsonState } from "./lib/vault-bridge-state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const VAULT_ROOT = requireVaultPath();
const { canonical: BRAIN_STATE_WRITE, legacy: BRAIN_STATE_LEGACY } = brainIngestStatePaths(
  VAULT_ROOT,
  REPO_ROOT
);
const WIKI_DIR_NAME = process.env.BRAIN_WIKI_DIR_NAME || "📒 Wiki";
const BRIDGE_URL = (process.env.BRIDGE_URL || "http://localhost:3000").replace(/\/$/, "");
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;

const REPLACE_ALL = process.argv.includes("--replace-all");
const REPLACE_EACH = process.argv.includes("--replace");
const PRUNE = process.argv.includes("--prune");
const DRY = process.argv.includes("--dry-run");

const INGEST_BATCH_SIZE = Math.max(
  1,
  parseInt(process.env.BRAIN_INGEST_BATCH_SIZE || "20", 10) || 20
);
const MAX_CHUNKS_PER_PAGE = Math.max(
  1,
  parseInt(process.env.BRAIN_MAX_CHUNKS_PER_PAGE || "25", 10) || 25
);

const dirToType = {
  sources: "source",
  entities: "entity",
  concepts: "concept",
  synthesis: "synthesis",
  essays: "synthesis"
};

function loadIngestState() {
  const { data } = loadJsonState(BRAIN_STATE_WRITE, BRAIN_STATE_LEGACY, () => ({ sources: {} }));
  const obj = data && typeof data === "object" ? data : {};
  const sources = obj.sources && typeof obj.sources === "object" ? obj.sources : {};
  /** Re-key under NFC so legacy NFD basenames compare with current walk. */
  const normalized = {};
  for (const [k, v] of Object.entries(sources)) {
    const key = String(k).normalize("NFC");
    if (!(key in normalized) || typeof v === "object") normalized[key] = v;
  }
  return { sources: normalized };
}

function saveIngestState(state) {
  saveJsonState(BRAIN_STATE_WRITE, state);
}

function getStateEntry(state, source) {
  const entry = state.sources?.[source];
  if (!entry) return null;
  if (typeof entry === "string") return { hash: entry, relFromWiki: null };
  return entry;
}

function setStateEntry(state, source, hash, relFromWiki) {
  state.sources[source] = { hash, relFromWiki };
}

async function fetchDocuments() {
  const url = new URL("/v1/brain/documents", BRIDGE_URL);
  const resp = await fetch(url.toString(), { headers: { "X-API-Key": BRIDGE_API_KEY } });
  if (!resp.ok) return new Set();
  const data = await resp.json();
  return new Set((data.documents || []).map((d) => d.source));
}

async function deleteSourceRemote(source) {
  const url = new URL("/v1/brain/documents", BRIDGE_URL);
  url.searchParams.set("source", source);
  const resp = await fetch(url.toString(), { method: "DELETE", headers: { "X-API-Key": BRIDGE_API_KEY } });
  if (!resp.ok) throw new Error(`DELETE failed ${source}: ${await resp.text()}`);
}

async function ingestChunks(chunks, replaceSource) {
  const url = new URL("/v1/brain/ingest", BRIDGE_URL);
  if (replaceSource) url.searchParams.set("replace_source", replaceSource);

  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": BRIDGE_API_KEY },
    body: JSON.stringify({ chunks })
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Ingest failed (${resp.status}): ${text}`);
  }
  return resp.json();
}

async function ingestChunksBatched(chunks, source) {
  if (chunks.length <= INGEST_BATCH_SIZE) {
    return ingestChunks(chunks, source);
  }

  let inserted = 0;
  for (let i = 0; i < chunks.length; i += INGEST_BATCH_SIZE) {
    const batch = chunks.slice(i, i + INGEST_BATCH_SIZE);
    const batchNum = Math.floor(i / INGEST_BATCH_SIZE) + 1;
    const batchTotal = Math.ceil(chunks.length / INGEST_BATCH_SIZE);
    const replaceSource = i === 0 ? source : undefined;
    console.log(`  lote ${batchNum}/${batchTotal} (${batch.length} chunk(s))`);
    const result = await ingestChunks(batch, replaceSource);
    inserted += result.inserted;
  }
  return { inserted, replaced_source: source };
}

function findRenamedSources(state, hash, currentSource) {
  const stale = [];
  const currentNfc = String(currentSource).normalize("NFC");
  for (const [source, entry] of Object.entries(state.sources || {})) {
    if (String(source).normalize("NFC") === currentNfc) continue;
    const normalized = getStateEntry(state, source);
    if (normalized?.hash === hash) stale.push(source);
  }
  return stale;
}

async function pruneOrphans(localSources, state) {
  const remote = await fetchDocuments();
  const orphans = [...remote].filter((s) => !localSources.has(s));
  if (orphans.length === 0) {
    console.log("Prune: no hay fuentes huérfanas remotas.");
    return 0;
  }

  console.log(`Prune: ${orphans.length} fuente(s) remota(s) sin fichero local.`);
  if (DRY) {
    for (const s of orphans) console.log(`  dry-run delete: ${s}`);
    return orphans.length;
  }

  for (const s of orphans) {
    try {
      await deleteSourceRemote(s);
      delete state.sources[s];
      console.log(`  eliminado remoto: ${s}`);
    } catch (e) {
      console.warn(`  skip delete ${s}: ${e.message}`);
    }
  }
  return orphans.length;
}

async function main() {
  if (!BRIDGE_API_KEY) {
    console.error("BRIDGE_API_KEY requerida");
    process.exit(1);
  }

  const wikiPath = path.join(VAULT_ROOT, WIKI_DIR_NAME);
  if (!fs.existsSync(wikiPath)) {
    console.error(`Wiki no encontrada: ${wikiPath}`);
    process.exit(1);
  }

  const files = listWikiMarkdownFiles(VAULT_ROOT, WIKI_DIR_NAME);
  if (files.length === 0) {
    console.log("No hay ficheros .md en la wiki (sources/entities/concepts/synthesis/essays).");
    process.exit(0);
  }

  console.log(`Wiki: ${wikiPath} (${files.length} ficheros)\n`);

  const localSources = new Set(files.map((f) => path.basename(f.fullPath).normalize("NFC")));
  const state = loadIngestState();
  state.sources = state.sources || {};

  if (PRUNE || REPLACE_ALL) {
    if (PRUNE && !REPLACE_ALL) {
      await pruneOrphans(localSources, state);
      console.log("");
    }
  }

  if (REPLACE_ALL) {
    if (DRY) console.log("--replace-all dry-run: borraría todas las filas brain por source remota");
    else {
      console.log("--replace-all: eliminando chunks existentes en servidor...");
      const existing = await fetchDocuments();
      for (const s of existing) {
        try {
          await deleteSourceRemote(s);
        } catch (e) {
          console.warn(`  skip delete ${s}: ${e.message}`);
        }
      }
      console.log("");
    }
    if (!DRY) state.sources = {};
  }

  let totalChunks = 0;
  let skipped = 0;

  for (const { fullPath, relFromWiki } of files) {
    const source = path.basename(fullPath).normalize("NFC");
    const raw = fs.readFileSync(fullPath, "utf8");
    const hash = sha256(raw);
    const { data, body } = parseFrontmatter(raw);

    const parentDir = path.basename(path.dirname(fullPath));
    const pageType = (data.type && String(data.type)) || dirToType[parentDir] || "source";
    const title = data.title ? String(data.title) : source.replace(/\.md$/i, "");
    const tags = Array.isArray(data.tags) ? data.tags.map(String) : [];
    const documentDate = resolveDocumentDate(data, fullPath);
    const eventDate = resolveEventDate(data, source, { pageType });

    const textChunks = chunkMarkdown(body);
    if (textChunks.length === 0) {
      console.log(`SKIP (vacío): ${source}`);
      continue;
    }

    if (textChunks.length > MAX_CHUNKS_PER_PAGE) {
      console.warn(
        `WARN (over-chunking): ${source} -> ${textChunks.length} chunks (umbral ${MAX_CHUNKS_PER_PAGE})`
      );
    }

    const prev = getStateEntry(state, source);
    if (!REPLACE_ALL && !REPLACE_EACH && prev?.hash === hash) {
      skipped++;
      continue;
    }

    const renamed = findRenamedSources(state, hash, source);
    if (renamed.length > 0 && !DRY) {
      for (const stale of renamed) {
        try {
          await deleteSourceRemote(stale);
          delete state.sources[stale];
          console.log(`  rename detectado: eliminado remoto ${stale} -> ${source}`);
        } catch (e) {
          console.warn(`  skip rename delete ${stale}: ${e.message}`);
        }
      }
    }

    const chunks = textChunks.map((content, chunk_index) => ({
      content,
      source,
      page_type: pageType,
      title,
      tags,
      document_date: documentDate,
      event_date: eventDate,
      chunk_index
    }));

    console.log(
      `${source} -> ${chunks.length} chunk(s) type=${pageType} doc=${documentDate || "null"} event=${eventDate || "null"}`
    );

    if (DRY) continue;

    try {
      const result = await ingestChunksBatched(chunks, source);
      console.log(`  insertados: ${result.inserted}`);
      totalChunks += result.inserted;
      setStateEntry(state, source, hash, relFromWiki);
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
    }

    console.log("");
  }

  if (PRUNE && !REPLACE_ALL && !DRY) {
    await pruneOrphans(localSources, state);
  }

  if (!DRY) saveIngestState(state);

  if (skipped > 0) console.log(`Omitidas ${skipped} página(s) sin cambios (hash local = estado).`);
  console.log(`Listo. Chunks insertados (esta ejecución): ${totalChunks}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
