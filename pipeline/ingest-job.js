#!/usr/bin/env node

/**
 * Script local para ingestar documentos laborales (PDFs) al RAG del servidor.
 *
 * Lee PDFs de una carpeta, extrae texto, trocea en chunks y los envía
 * al endpoint POST /v1/job/ingest del servidor en bridge.
 *
 * Los PDFs NO se suben: solo se envía texto + metadatos.
 *
 * Uso:
 *   JOB_DOCS_PATH=./job-docs BRIDGE_URL=http://127.0.0.1:3000 BRIDGE_API_KEY=xxx node pipeline/ingest-job.js
 *
 * Variables de entorno:
 *   JOB_DOCS_PATH  - Carpeta con los PDFs (obligatoria)
 *   BRIDGE_URL     - URL base del servidor (default: http://localhost:3000)
 *   BRIDGE_API_KEY - API key para autenticar
 *
 * Estructura de carpetas esperada (el tipo se infiere del subdirectorio):
 *   job-docs/
 *     nominas/
 *       nomina_2024_01.pdf
 *       nomina_2024_02.pdf
 *     contratos/
 *       contrato_2024.pdf
 *     excedencias/
 *       excedencia_2025.pdf
 *     certificados/
 *       retenciones_2024.pdf
 *     otros/
 *       documento.pdf
 *
 * Si los PDFs están directamente en la raíz (sin subcarpetas), el tipo será "otro".
 * La fecha del documento se intenta extraer del nombre del fichero (YYYY_MM o YYYY-MM).
 *
 * Opciones:
 *   --replace-all   Borra TODOS los chunks antes de ingestar (re-ingesta completa)
 *   --replace       Borra los chunks de cada source antes de insertar (re-ingesta por fichero)
 */

import { requireDocsPath } from "./lib/layout.js";
import fs from "fs";
import path from "path";
import { PDFParse } from "pdf-parse";

const JOB_DOCS_PATH = requireDocsPath("JOB_DOCS_PATH");
const BRIDGE_URL = (process.env.BRIDGE_URL || "http://localhost:3000").replace(/\/$/, "");
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;

if (!BRIDGE_API_KEY) {
  console.error("Error: BRIDGE_API_KEY is required");
  process.exit(1);
}

const REPLACE_ALL = process.argv.includes("--replace-all");
const REPLACE_EACH = process.argv.includes("--replace");

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;
const SINGLE_CHUNK_THRESHOLD = 2000;

const TYPE_MAP = {
  nominas: "nomina",
  nomina: "nomina",
  contratos: "contrato",
  contrato: "contrato",
  excedencias: "excedencia",
  excedencia: "excedencia",
  certificados: "certificado_retenciones",
  certificado: "certificado_retenciones",
  retenciones: "certificado_retenciones",
  vida_laboral: "vida_laboral",
  otros: "otro",
  otros_docs: "otro",
  otro: "otro"
};

function inferType(relDir, filename) {
  const lowerName = filename.toLowerCase();
  if (lowerName.includes("vida_laboral") || lowerName.includes("vida laboral")) return "vida_laboral";
  if (lowerName.includes("finiquito")) return "finiquito";

  if (!relDir || relDir === ".") return "otro";
  const first = relDir.split(path.sep)[0].toLowerCase();
  return TYPE_MAP[first] || "otro";
}

function inferDate(filename) {
  const ymd = filename.match(/(\d{4})[_\-.](\d{2})/);
  if (ymd) return `${ymd[1]}-${ymd[2]}`;

  const mdy = filename.match(/(\d{2})[_\-.](\d{4})/);
  if (mdy) return `${mdy[2]}-${mdy[1]}`;

  const yearOnly = filename.match(/(\d{4})/);
  if (yearOnly && +yearOnly[1] >= 2000 && +yearOnly[1] <= 2099) return yearOnly[1];

  return null;
}

function chunkText(text) {
  const trimmed = text.trim();
  if (trimmed.length <= SINGLE_CHUNK_THRESHOLD) {
    return trimmed.length > 20 ? [trimmed] : [];
  }
  const chunks = [];
  let start = 0;
  while (start < trimmed.length) {
    const end = Math.min(start + CHUNK_SIZE, trimmed.length);
    chunks.push(trimmed.slice(start, end).trim());
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks.filter(c => c.length > 20);
}

function findPDFs(dir, base = dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findPDFs(fullPath, base));
    } else if (entry.name.toLowerCase().endsWith(".pdf")) {
      results.push({ fullPath, relDir: path.relative(base, dir), filename: entry.name });
    }
  }
  return results;
}

async function ingestChunks(chunks, replaceSource) {
  const url = new URL("/v1/job/ingest", BRIDGE_URL);
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

async function fetchIndexedSources() {
  const url = new URL("/v1/job/documents", BRIDGE_URL);
  const resp = await fetch(url.toString(), { headers: { "X-API-Key": BRIDGE_API_KEY } });
  if (!resp.ok) return new Set();
  const data = await resp.json();
  return new Set((data.documents || []).map(d => d.source));
}

async function main() {
  const absPath = path.resolve(JOB_DOCS_PATH);
  console.log(`Scanning PDFs in: ${absPath}`);
  const pdfs = findPDFs(absPath);

  if (pdfs.length === 0) {
    console.log("No PDF files found.");
    process.exit(0);
  }

  console.log(`Found ${pdfs.length} PDF(s)\n`);

  if (REPLACE_ALL) {
    console.log("--replace-all: deleting all existing chunks first...");
    for (const p of pdfs) {
      const url = new URL("/v1/job/documents", BRIDGE_URL);
      url.searchParams.set("source", p.filename);
      await fetch(url.toString(), { method: "DELETE", headers: { "X-API-Key": BRIDGE_API_KEY } });
    }
    console.log("");
  }

  let existingSources = new Set();
  if (!REPLACE_ALL && !REPLACE_EACH) {
    existingSources = await fetchIndexedSources();
    if (existingSources.size > 0) {
      console.log(`Already indexed: ${existingSources.size} document(s)`);
    }
  }

  let totalChunks = 0;
  let skipped = 0;

  for (const p of pdfs) {
    if (!REPLACE_ALL && !REPLACE_EACH && existingSources.has(p.filename)) {
      skipped++;
      continue;
    }
    const docType = inferType(p.relDir, p.filename);
    const docDate = inferDate(p.filename);

    console.log(`Processing: ${p.filename}`);
    console.log(`  Type: ${docType}${docDate ? `, Date: ${docDate}` : ""}`);

    const buffer = fs.readFileSync(p.fullPath);
    let text;
    try {
      const parser = new PDFParse(new Uint8Array(buffer));
      await parser.load();
      const result = await parser.getText();
      text = result.text;
      parser.destroy();
    } catch (e) {
      console.log(`  ERROR extracting text: ${e.message} — skipping`);
      continue;
    }

    if (!text || text.trim().length < 200) {
      console.log(`  WARNING: very little useful text extracted (${text ? text.trim().length : 0} chars) — skipping`);
      console.log("  (This PDF might be scanned/image-based. Consider OCR or manual transcription.)");
      continue;
    }

    const chunks = chunkText(text).map(content => ({
      content,
      source: p.filename,
      document_type: docType,
      document_date: docDate
    }));

    console.log(`  Chunks: ${chunks.length}`);

    try {
      const result = await ingestChunks(chunks, REPLACE_EACH ? p.filename : undefined);
      console.log(`  Inserted: ${result.inserted}`);
      totalChunks += result.inserted;
    } catch (e) {
      console.log(`  ERROR ingesting: ${e.message}`);
    }

    console.log("");
  }

  if (skipped > 0) console.log(`Skipped ${skipped} already-indexed document(s)`);
  console.log(`¡Hecho! Chunks insertados (esta ejecución): ${totalChunks}`);
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
