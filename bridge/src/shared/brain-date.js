/**
 * Normalize brain document_date / event_date values to YYYY-MM-DD for ingest and search filters.
 */

import fs from "fs";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/** @returns {string} YYYY-MM-DD in UTC */
export function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * @param {string} sourceOrPath basename or path
 * @returns {string | null} YYYY-MM-DD
 */
export function extractDateFromFilename(sourceOrPath) {
  const base = String(sourceOrPath || "").split("/").pop() || "";
  const iso = base.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dotted = base.match(/(\d{4})\.(\d{2})\.(\d{2})/);
  if (dotted) return `${dotted[1]}-${dotted[2]}-${dotted[3]}`;
  return null;
}

/**
 * @param {unknown} raw
 * @param {{ fallback?: string | null, maxDate?: string, allowFutureDays?: number }} [opts]
 * @returns {string | null}
 */
export function normalizeDocumentDate(raw, opts = {}) {
  const { fallback = null, maxDate = todayUtc(), allowFutureDays = 1 } = opts;
  const candidates = [raw, fallback].filter((v) => v != null && String(v).trim() !== "");

  for (const candidate of candidates) {
    const parsed = parseToIsoDate(String(candidate).trim());
    if (!parsed) continue;
    if (isWithinAllowedRange(parsed, maxDate, allowFutureDays)) return parsed;
  }

  if (fallback) {
    const fb = parseToIsoDate(String(fallback).trim());
    if (fb && isWithinAllowedRange(fb, maxDate, allowFutureDays)) return fb;
  }

  return null;
}

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
export function parseToIsoDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(ISO_DATE);
  if (!m) return null;
  const [, y, mo, d] = m;
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (
    dt.getUTCFullYear() !== Number(y) ||
    dt.getUTCMonth() !== Number(mo) - 1 ||
    dt.getUTCDate() !== Number(d)
  ) {
    return null;
  }
  return `${y}-${mo}-${d}`;
}

function isWithinAllowedRange(isoDate, maxDate, allowFutureDays) {
  const max = parseToIsoDate(maxDate) || todayUtc();
  const maxDt = new Date(`${max}T00:00:00Z`);
  maxDt.setUTCDate(maxDt.getUTCDate() + Math.max(0, allowFutureDays));
  const candidate = new Date(`${isoDate}T00:00:00Z`);
  return candidate <= maxDt;
}

/**
 * @param {unknown} raw
 * @param {{ boundary?: "start" | "end" }} [opts]
 * @returns {string | null}
 */
export function normalizeSearchDate(raw, opts = {}) {
  if (!raw) return null;
  const parsed = parseToIsoDate(raw);
  if (parsed) return parsed;

  const s = String(raw).trim();
  const month = s.match(/^(\d{4})-(\d{2})$/);
  if (!month) return null;
  const year = Number(month[1]);
  const monthNumber = Number(month[2]);
  if (monthNumber < 1 || monthNumber > 12) return null;
  if (opts.boundary === "end") {
    const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    return `${month[1]}-${month[2]}-${String(lastDay).padStart(2, "0")}`;
  }
  return `${month[1]}-${month[2]}-01`;
}

/**
 * Wiki page freshness: updated/created/mtime only (not source filename).
 * @param {Record<string, unknown>} data frontmatter
 * @param {string} fullPath absolute path to wiki markdown
 * @returns {string | null}
 */
export function resolveDocumentDate(data, fullPath) {
  const created = data.created ? String(data.created) : null;
  const updated = data.updated ? String(data.updated) : null;
  const maxDate = todayUtc();
  let mtimeIso = null;
  try {
    mtimeIso = fs.statSync(fullPath).mtime.toISOString().slice(0, 10);
  } catch {
    mtimeIso = null;
  }

  return (
    normalizeDocumentDate(updated, { fallback: created, maxDate, allowFutureDays: 1 }) ||
    normalizeDocumentDate(created, { maxDate, allowFutureDays: 1 }) ||
    normalizeDocumentDate(mtimeIso, { maxDate, allowFutureDays: 1 })
  );
}

/**
 * Event/source date: when the underlying fact or vault source occurred.
 * @param {Record<string, unknown>} data frontmatter
 * @param {string} source wiki basename
 * @param {{ pageType?: string }} [opts]
 * @returns {string | null}
 */
export function resolveEventDate(data, source, { pageType } = {}) {
  const maxDate = todayUtc();
  const sourceVault = data.source_vault ? String(data.source_vault) : null;
  const explicit = data.event_date ? String(data.event_date) : null;
  const fromVault = sourceVault ? extractDateFromFilename(sourceVault) : null;
  const fromSource = extractDateFromFilename(source);
  const fromDateField =
    pageType === "source" && data.date ? String(data.date) : null;

  return (
    normalizeDocumentDate(explicit, { maxDate, allowFutureDays: 0 }) ||
    normalizeDocumentDate(fromVault, { maxDate, allowFutureDays: 0 }) ||
    normalizeDocumentDate(fromSource, { maxDate, allowFutureDays: 0 }) ||
    normalizeDocumentDate(fromDateField, { maxDate, allowFutureDays: 0 })
  );
}
