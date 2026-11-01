/**
 * Classify vault source docs as log/reference (extractive) vs narrative (LLM summary).
 *
 * Heuristic (validated on the live vault):
 *   facts >= 20 AND (tableLines >= 20% OR datedHeadings >= 5) AND length >= 4000
 *
 * Guard: if an existing source page for this vault path already retains >=
 * WIKI_EXTRACTIVE_MIN_EXISTING_RETENTION (default 0.85), skip — converting a
 * faithful synthesis into a data dump is churn with no fidelity gain.
 *
 * Overrides:
 *   WIKI_EXTRACTIVE_PATHS   — comma-separated vault-relative paths always extractive
 *   WIKI_EXTRACTIVE_EXCLUDE — comma-separated paths never extractive
 */

import { extractFacts, factRetention } from "./wiki-fact-retention.js";
import { normalizePathKey } from "./vault-diff.js";

const DEFAULT_MIN_FACTS = 20;
const DEFAULT_MIN_CHARS = 4000;
const DEFAULT_TABLE_PCT = 20;
const DEFAULT_DATED_HEADINGS = 5;
const DEFAULT_MIN_EXISTING_RETENTION = 0.85;

function parsePathList(envVal) {
  if (!envVal || !String(envVal).trim()) return new Set();
  return new Set(
    String(envVal)
      .split(",")
      .map((s) => normalizePathKey(s.trim()))
      .filter(Boolean)
  );
}

function countTableLines(raw) {
  const lines = String(raw || "").split(/\r?\n/);
  if (lines.length === 0) return 0;
  const table = lines.filter((l) => /^\s*\|/.test(l)).length;
  return (100 * table) / lines.length;
}

function countDatedHeadings(raw) {
  const lines = String(raw || "").split(/\r?\n/);
  let n = 0;
  for (const line of lines) {
    if (/^#{2,4}\s+\d{4}-\d{2}-\d{2}/.test(line)) {
      n++;
      continue;
    }
    if (/^#{2,4}\s+.*\d{4}[-./]\d{1,2}[-./]\d{1,2}/.test(line)) n++;
  }
  return n;
}

/**
 * @param {string} relPath vault-relative path
 * @param {string} content raw markdown
 * @param {{ existingSourcePage?: string | null, titleIndex?: object }} [opts]
 * @returns {{ extractive: boolean, reason: string, metrics: object }}
 */
export function classifySourceDoc(relPath, content, opts = {}) {
  const rel = normalizePathKey(relPath);
  const force = parsePathList(process.env.WIKI_EXTRACTIVE_PATHS);
  const exclude = parsePathList(process.env.WIKI_EXTRACTIVE_EXCLUDE);

  if (exclude.has(rel)) {
    return { extractive: false, reason: "excluded_by_env", metrics: {} };
  }
  if (force.has(rel)) {
    return { extractive: true, reason: "forced_by_env", metrics: {} };
  }

  const len = String(content || "").length;
  const facts = extractFacts(content).size;
  const tablePct = countTableLines(content);
  const datedHeadings = countDatedHeadings(content);
  const metrics = { len, facts, tablePct: Math.round(tablePct * 10) / 10, datedHeadings };

  const minFacts = Number(process.env.WIKI_EXTRACTIVE_MIN_FACTS || DEFAULT_MIN_FACTS);
  const minChars = Number(process.env.WIKI_EXTRACTIVE_MIN_CHARS || DEFAULT_MIN_CHARS);
  const minTable = Number(process.env.WIKI_EXTRACTIVE_MIN_TABLE_PCT || DEFAULT_TABLE_PCT);
  const minDated = Number(process.env.WIKI_EXTRACTIVE_MIN_DATED_HEADINGS || DEFAULT_DATED_HEADINGS);

  const heuristic =
    len >= minChars && facts >= minFacts && (tablePct >= minTable || datedHeadings >= minDated);

  if (!heuristic) {
    return { extractive: false, reason: "not_log_reference", metrics };
  }

  // Guard: skip if existing source page already retains well.
  const existing = opts.existingSourcePage;
  if (existing) {
    const minRet = Number(
      process.env.WIKI_EXTRACTIVE_MIN_EXISTING_RETENTION ?? DEFAULT_MIN_EXISTING_RETENTION
    );
    if (minRet > 0) {
      const { retention, total } = factRetention(content, existing, {
        titleIndex: opts.titleIndex
      });
      metrics.existingRetention = retention;
      metrics.existingFacts = total;
      if (total >= 5 && retention >= minRet) {
        return {
          extractive: false,
          reason: `existing_retention_ok (${(retention * 100).toFixed(1)}% >= ${Math.round(minRet * 100)}%)`,
          metrics
        };
      }
    }
  }

  return { extractive: true, reason: "log_reference_heuristic", metrics };
}
