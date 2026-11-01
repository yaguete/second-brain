#!/usr/bin/env node

/**
 * Diagnóstico y mantenimiento del índice brain (wiki local vs bridge).
 *
 * Uso:
 *   npm run maintain:brain
 *   npm run maintain:brain -- --json
 *   npm run maintain:brain -- --prune
 *   npm run maintain:brain -- --ingest
 *   npm run maintain:brain -- --dry-run
 */

import { requireVaultPath } from "./lib/layout.js";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import {
  buildWikiTitleIndex,
  listWikiMarkdownFiles,
  normForCompare,
  parseFrontmatter,
  sha256
} from "./lib/brain-wiki.js";
import { extractDateFromFilename, normalizeDocumentDate, resolveDocumentDate, resolveEventDate, todayUtc } from "../bridge/src/shared/brain-date.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const ENV_FILE = path.join(REPO_ROOT, ".env");

const VAULT_ROOT = requireVaultPath();
const WIKI_DIR_NAME = process.env.BRAIN_WIKI_DIR_NAME || "📒 Wiki";
const BRIDGE_URL = (process.env.BRIDGE_URL || "http://localhost:3000").replace(/\/$/, "");
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;

const JSON_OUT = process.argv.includes("--json");
const PRUNE = process.argv.includes("--prune");
const INGEST = process.argv.includes("--ingest");
const DRY = process.argv.includes("--dry-run");

const VALID_PAGE_TYPES = new Set(["source", "entity", "concept", "synthesis", "essay"]);
const CHUNK_WARN = parseInt(process.env.BRAIN_MAX_CHUNKS_PER_PAGE || "25", 10) || 25;

function estimateChunks(body) {
  const parts = body.split(/^##\s+/m).filter(Boolean);
  return Math.max(1, parts.length);
}

async function fetchRemoteDocuments() {
  if (!BRIDGE_API_KEY) return [];
  const url = new URL("/v1/brain/documents", BRIDGE_URL);
  const resp = await fetch(url.toString(), { headers: { "X-API-Key": BRIDGE_API_KEY } });
  if (!resp.ok) throw new Error(`GET /v1/brain/documents failed: ${resp.status}`);
  const data = await resp.json();
  return data.documents || [];
}

function scanLocalWiki() {
  const files = listWikiMarkdownFiles(VAULT_ROOT, WIKI_DIR_NAME);
  const titleIndex = buildWikiTitleIndex(VAULT_ROOT, WIKI_DIR_NAME);
  const duplicateTitles = [];
  for (const [title, sources] of titleIndex.byTitle.entries()) {
    if (sources.length > 1) duplicateTitles.push({ title, sources });
  }

  const invalidPageTypes = [];
  const futureDocumentDates = [];
  const futureEventDates = [];
  const nullDocumentDates = [];
  const nullEventDates = [];
  const largePages = [];
  const contentHashes = new Map();

  for (const { fullPath } of files) {
    const source = path.basename(fullPath);
    const raw = fs.readFileSync(fullPath, "utf8");
    const hash = sha256(raw);
    const { data, body } = parseFrontmatter(raw);
    const pageType = data.type ? String(data.type) : null;
    if (pageType && !VALID_PAGE_TYPES.has(pageType)) {
      invalidPageTypes.push({ source, page_type: pageType });
    }

    const documentDate = resolveDocumentDate(data, fullPath);
    const pageTypeResolved =
      (data.type && String(data.type)) ||
      (path.basename(path.dirname(fullPath)) === "entities"
        ? "entity"
        : path.basename(path.dirname(fullPath)) === "concepts"
          ? "concept"
          : path.basename(path.dirname(fullPath)) === "synthesis"
            ? "synthesis"
            : path.basename(path.dirname(fullPath)) === "essays"
              ? "essay"
              : "source");
    const eventDate = resolveEventDate(data, source, { pageType: pageTypeResolved });

    if (!documentDate) nullDocumentDates.push(source);
    else if (documentDate > todayUtc()) futureDocumentDates.push({ source, document_date: documentDate });

    if (!eventDate) nullEventDates.push(source);
    else if (eventDate > todayUtc()) futureEventDates.push({ source, event_date: eventDate });

    const est = estimateChunks(body);
    if (est > CHUNK_WARN) largePages.push({ source, estimated_chunks: est });

    if (!contentHashes.has(hash)) contentHashes.set(hash, []);
    contentHashes.get(hash).push(source);
  }

  const duplicateContent = [...contentHashes.entries()]
    .filter(([, sources]) => sources.length > 1)
    .map(([hash, sources]) => ({ hash: hash.slice(0, 12), sources }));

  return {
    local_count: files.length,
    local_sources: new Set(files.map((f) => path.basename(f.fullPath))),
    duplicate_titles: duplicateTitles,
    invalid_page_types: invalidPageTypes,
    future_document_dates: futureDocumentDates,
    future_event_dates: futureEventDates,
    null_document_dates: nullDocumentDates,
    null_event_dates: nullEventDates,
    large_pages: largePages.sort((a, b) => b.estimated_chunks - a.estimated_chunks),
    duplicate_content: duplicateContent
  };
}

function runIngest(extraArgs = []) {
  const scriptPath = path.join(REPO_ROOT, "scripts/ingest-brain.js");
  const r = spawnSync(
    process.execPath,
    ["--env-file", ENV_FILE, scriptPath, ...extraArgs],
    { cwd: REPO_ROOT, stdio: "inherit", env: process.env }
  );
  if (r.status !== 0) process.exit(r.status ?? 1);
}

async function main() {
  const local = scanLocalWiki();
  let remote = [];
  let orphans = [];

  if (BRIDGE_API_KEY) {
    try {
      remote = await fetchRemoteDocuments();
      orphans = remote
        .map((d) => d.source)
        .filter((source) => !local.local_sources.has(source));
    } catch (e) {
      console.warn(`No se pudo consultar remoto: ${e.message}`);
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    local_count: local.local_count,
    remote_count: remote.length,
    orphans_remote: orphans,
    duplicate_titles: local.duplicate_titles,
    invalid_page_types: local.invalid_page_types,
    future_document_dates: local.future_document_dates,
    future_event_dates: local.future_event_dates,
    null_document_dates: local.null_document_dates,
    null_event_dates: local.null_event_dates,
    large_pages: local.large_pages.slice(0, 20),
    duplicate_content: local.duplicate_content
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("=== maintain:brain ===\n");
    console.log(`Local: ${report.local_count} páginas | Remoto: ${report.remote_count} fuentes`);
    if (orphans.length) console.log(`Huérfanos remotos: ${orphans.length}`);
    if (local.duplicate_titles.length) {
      console.log(`Títulos duplicados: ${local.duplicate_titles.length}`);
      for (const d of local.duplicate_titles.slice(0, 10)) {
        console.log(`  - "${d.title}" -> ${d.sources.join(", ")}`);
      }
    }
    if (local.large_pages.length) {
      console.log(`Páginas grandes (>${CHUNK_WARN} chunks est.): ${local.large_pages.length}`);
      for (const p of local.large_pages.slice(0, 8)) {
        console.log(`  - ${p.source}: ~${p.estimated_chunks} chunks`);
      }
    }
    if (local.future_document_dates.length) {
      console.log(`Fechas documento futuras: ${local.future_document_dates.length}`);
    }
    if (local.future_event_dates.length) {
      console.log(`Fechas evento futuras: ${local.future_event_dates.length}`);
    }
    if (local.null_document_dates.length) {
      console.log(`Fechas documento null: ${local.null_document_dates.length}`);
    }
    if (local.null_event_dates.length) {
      console.log(`Fechas evento null: ${local.null_event_dates.length}`);
    }
    if (local.duplicate_content.length) {
      console.log(`Contenido duplicado (hash): ${local.duplicate_content.length}`);
    }
  }

  if (PRUNE || INGEST) {
    const args = [];
    if (DRY) args.push("--dry-run");
    if (PRUNE) args.push("--prune");
    if (INGEST) args.push("--replace");
    if (!JSON_OUT) console.log("\nEjecutando ingest-brain...");
    runIngest(args);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
