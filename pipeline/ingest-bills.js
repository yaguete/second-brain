#!/usr/bin/env node

/**
 * Script local para ingestar facturas (PDFs) al RAG del servidor.
 *
 * Lee PDFs de una carpeta, extrae texto, trocea en chunks y los envía
 * al endpoint POST /v1/bills/ingest del servidor en bridge.
 *
 * Los PDFs NO se suben: solo se envía texto + metadatos.
 *
 * Para PDFs escaneados (sin texto embebido), usa OCR via OpenAI Vision
 * + pdftoppm (poppler). Instalar: brew install poppler
 *
 * Uso:
 *   BRIDGE_URL=http://127.0.0.1:3000 \
 *   BRIDGE_API_KEY=xxx \
 *   OPENAI_API_KEY=xxx \
 *   node scripts/ingest-bills.js
 *
 * Variables de entorno:
 *   BILLS_DOCS_PATH  - Carpeta con los PDFs de facturas (obligatorio)
 *   BRIDGE_URL       - URL base del servidor (default: http://localhost:3000)
 *   BRIDGE_API_KEY   - API key para autenticar
 *   OPENAI_API_KEY   - API key de OpenAI para OCR de PDFs escaneados (opcional pero recomendado)
 *   OPENAI_CHAT_MODEL - Modelo para OCR vía visión (default: gpt-4o-mini)
 *
 * Estructura de carpetas esperada (el tipo se infiere del subdirectorio):
 *   bills/
 *     Agua/
 *       AB 07.02.2024.pdf
 *     Electricidad/
 *       EL 19.08.2024.pdf
 *     Gas Natural/
 *       GN 01.03.2026.pdf
 *     Otros/
 *       Contrato arrendamiento.pdf
 *
 * Si los PDFs están directamente en la raíz (sin subcarpetas), el tipo será "factura_otro".
 * La fecha se extrae del nombre del fichero (DD.MM.YYYY o DD.MM.YY).
 *
 * Opciones:
 *   --replace-all   Borra TODOS los chunks de facturas antes de ingestar
 *   --replace       Borra los chunks de cada source antes de insertar (re-ingesta por fichero)
 */

import { requireDocsPath } from "./lib/layout.js";
import fs from "fs";
import path from "path";
import { tmpdir } from "os";
import { execFileSync, execSync } from "child_process";
import { PDFParse } from "pdf-parse";
import OpenAI from "openai";
import { CHAT_MODEL, llmExtract } from "../bridge/src/shared/openai.js";
import { recordUsage } from "../bridge/src/shared/llm-usage.js";
import {
  BILL_EXTRACT_PROMPT,
  BILL_EXTRACT_PROMPT_VERSION
} from "../bridge/src/modules/bills/prompts.js";

const BILLS_DOCS_PATH = requireDocsPath("BILLS_DOCS_PATH");
const BRIDGE_URL = (process.env.BRIDGE_URL || "http://localhost:3000").replace(/\/$/, "");
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!BRIDGE_API_KEY) {
  console.error("Error: BRIDGE_API_KEY is required");
  process.exit(1);
}

// OCR setup
let openaiClient = null;
let canOcr = false;

if (OPENAI_API_KEY) {
  openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
  try {
    execSync("which pdftoppm", { stdio: "pipe" });
    canOcr = true;
    console.log("OCR enabled (pdftoppm + OpenAI Vision)\n");
  } catch {
    console.log("WARNING: pdftoppm not found. Install with: brew install poppler");
    console.log("Scanned PDFs will be skipped.\n");
  }
} else {
  console.log("WARNING: OPENAI_API_KEY not set. Scanned PDFs will be skipped.");
  console.log("Set it to enable OCR for image-based PDFs.\n");
}

const REPLACE_ALL = process.argv.includes("--replace-all");
const REPLACE_EACH = process.argv.includes("--replace");

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;
const SINGLE_CHUNK_THRESHOLD = 2000;
const MIN_TEXT_THRESHOLD = 100;

const TYPE_MAP = {
  agua: "factura_agua",
  electricidad: "factura_electricidad",
  "gas natural": "factura_gas",
  gas: "factura_gas",
  otros: "factura_otro"
};

function inferType(relDir) {
  if (!relDir || relDir === ".") return "factura_otro";
  const first = relDir.split(path.sep)[0].toLowerCase();
  return TYPE_MAP[first] || "factura_otro";
}

function inferDate(filename) {
  const dmy4 = filename.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (dmy4) return `${dmy4[3]}-${dmy4[2]}`;

  const dmy2 = filename.match(/(\d{2})\.(\d{2})\.(\d{2})(?!\d)/);
  if (dmy2) {
    const year = +dmy2[3] >= 50 ? `19${dmy2[3]}` : `20${dmy2[3]}`;
    return `${year}-${dmy2[2]}`;
  }

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

// ── OCR functions ───────────────────────────────────────────────────────────

function pdfToImages(pdfPath) {
  const tmpDir = fs.mkdtempSync(path.join(tmpdir(), "bills-ocr-"));
  try {
    execFileSync("pdftoppm", ["-jpeg", "-r", "150", pdfPath, path.join(tmpDir, "page")], {
      stdio: "pipe",
      timeout: 120_000
    });
    return fs.readdirSync(tmpDir)
      .filter(f => f.endsWith(".jpg"))
      .sort()
      .map(f => fs.readFileSync(path.join(tmpDir, f)));
  } finally {
    try {
      for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
      fs.rmdirSync(tmpDir);
    } catch { /* cleanup best-effort */ }
  }
}

async function ocrWithVision(imageBuffers) {
  const content = [
    { type: "text", text: "Extract ALL text from this utility bill image. Return the complete text exactly as it appears, preserving all numbers, dates, amounts, units, and structure. Respond only with the extracted text, no commentary or formatting." }
  ];
  for (const buf of imageBuffers) {
    content.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${buf.toString("base64")}`, detail: "high" }
    });
  }

  const res = await openaiClient.chat.completions.create({
    model: CHAT_MODEL,
    messages: [{ role: "user", content }],
    max_tokens: 4000,
    temperature: 0
  });
  recordUsage({
    step: "ocr",
    model: CHAT_MODEL,
    usage: res.usage,
    message: res.choices?.[0]?.message,
    extra: { pages: imageBuffers.length }
  });
  return res.choices[0].message.content;
}

// ── Ingest functions ────────────────────────────────────────────────────────

async function ingestChunks(chunks, replaceSource, extraction) {
  const url = new URL("/v1/bills/ingest", BRIDGE_URL);
  if (replaceSource) url.searchParams.set("replace_source", replaceSource);

  const body = { chunks };
  if (extraction) body.extraction = extraction;

  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": BRIDGE_API_KEY },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Ingest failed (${resp.status}): ${text}`);
  }

  return resp.json();
}

async function fetchIndexedSources() {
  const url = new URL("/v1/bills/documents", BRIDGE_URL);
  const resp = await fetch(url.toString(), { headers: { "X-API-Key": BRIDGE_API_KEY } });
  if (!resp.ok) return new Set();
  const data = await resp.json();
  return new Set((data.documents || []).map(d => d.source));
}

async function main() {
  const absPath = path.resolve(BILLS_DOCS_PATH);
  console.log(`Scanning PDFs in: ${absPath}`);
  const pdfs = findPDFs(absPath);

  if (pdfs.length === 0) {
    console.log("No PDF files found.");
    process.exit(0);
  }

  console.log(`Found ${pdfs.length} PDF(s)\n`);

  if (REPLACE_ALL) {
    console.log("--replace-all: deleting all existing bill chunks first...");
    for (const p of pdfs) {
      const url = new URL("/v1/bills/documents", BRIDGE_URL);
      url.searchParams.set("source", p.filename);
      await fetch(url.toString(), { method: "DELETE", headers: { "X-API-Key": BRIDGE_API_KEY } });
    }
    console.log("");
  }

  let existingSources = new Set();
  if (!REPLACE_ALL && !REPLACE_EACH) {
    existingSources = await fetchIndexedSources();
    if (existingSources.size > 0) {
      console.log(`Already indexed: ${existingSources.size} bill(s)\n`);
    }
  }

  let totalChunks = 0;
  let skipped = 0;
  let ocrCount = 0;

  for (const p of pdfs) {
    if (!REPLACE_ALL && !REPLACE_EACH && existingSources.has(p.filename)) {
      skipped++;
      continue;
    }
    const docType = inferType(p.relDir);
    const docDate = inferDate(p.filename);

    console.log(`Processing: ${p.filename}`);
    console.log(`  Type: ${docType}${docDate ? `, Date: ${docDate}` : ""}`);

    const buffer = fs.readFileSync(p.fullPath);
    let text;
    let usedOcr = false;

    // 1. Try pdf-parse (text-based PDFs)
    try {
      const parser = new PDFParse(new Uint8Array(buffer));
      await parser.load();
      const result = await parser.getText();
      text = result.text;
      parser.destroy();
    } catch (e) {
      console.log(`  pdf-parse error: ${e.message}`);
      text = "";
    }

    // 2. Fallback: OCR via pdftoppm + OpenAI Vision
    if ((!text || text.trim().length < MIN_TEXT_THRESHOLD) && canOcr) {
      console.log(`  Text extraction insufficient (${text ? text.trim().length : 0} chars), trying OCR...`);
      try {
        const images = pdfToImages(p.fullPath);
        console.log(`  Converting: ${images.length} page(s) to images`);
        text = await ocrWithVision(images);
        usedOcr = true;
        ocrCount++;
        console.log(`  OCR extracted ${text.trim().length} chars`);
      } catch (ocrErr) {
        console.log(`  OCR failed: ${ocrErr.message}`);
        text = "";
      }
    }

    if (!text || text.trim().length < MIN_TEXT_THRESHOLD) {
      console.log(`  SKIPPED: insufficient text (${text ? text.trim().length : 0} chars)`);
      if (!canOcr) console.log("  (Set OPENAI_API_KEY and install poppler to enable OCR)");
      console.log("");
      continue;
    }

    const chunks = chunkText(text).map(content => ({
      content,
      source: p.filename,
      document_type: docType,
      document_date: docDate
    }));

    console.log(`  Chunks: ${chunks.length}${usedOcr ? " (via OCR)" : ""}`);

    let extraction = null;
    if (OPENAI_API_KEY) {
      try {
        const payload = await llmExtract(text, BILL_EXTRACT_PROMPT, "bills:ingest_extract");
        extraction = {
          source: p.filename,
          prompt_version: BILL_EXTRACT_PROMPT_VERSION,
          payload
        };
        console.log(`  Extraction: precomputed (${BILL_EXTRACT_PROMPT_VERSION})`);
      } catch (extractErr) {
        console.log(`  Extraction skipped: ${extractErr.message}`);
      }
    }

    try {
      const result = await ingestChunks(chunks, REPLACE_EACH ? p.filename : undefined, extraction);
      console.log(`  Inserted: ${result.inserted}${result.extraction_upserted ? " + extraction" : ""}`);
      totalChunks += result.inserted;
    } catch (e) {
      console.log(`  ERROR ingesting: ${e.message}`);
    }

    console.log("");
  }

  if (skipped > 0) console.log(`Skipped ${skipped} already-indexed bill(s)`);
  if (ocrCount > 0) console.log(`OCR used for ${ocrCount} scanned PDF(s)`);
  console.log(`¡Hecho! Chunks insertados (esta ejecución): ${totalChunks}`);
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
