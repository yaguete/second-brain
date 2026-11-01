import test from "node:test";
import assert from "node:assert/strict";
import { classifySourceDoc } from "./wiki-source-classify.js";

/** Build a log-like doc with ≥20 hard facts and ≥5 dated headings. */
function buildLogDoc() {
  const entries = [];
  for (let d = 1; d <= 12; d++) {
    const day = String(d).padStart(2, "0");
    entries.push(`## 2026-07-${day} — Evento ${d}

- **Importe:** ${1000 + d * 11} €
- **Fecha EU:** ${day}/07/2026
- **Pct:** ${10 + d}%
`);
  }
  return `---
title: Bitácora
---
# Bitácora

${entries.join("\n")}
${"contexto ".repeat(500)}
`;
}

function buildTableDoc() {
  const rows = [];
  for (let i = 0; i < 25; i++) {
    const day = String((i % 28) + 1).padStart(2, "0");
    rows.push(
      `| T${i} | 2026-06-${day} | ${100 + i * 3},50 € | ${5 + (i % 9)}0% |`
    );
  }
  return `---
title: Portfolio
---
# Portfolio

Total **58.753,16 €** a 2026-07-25. También 2026-06-30 y 2026-05-12.

| Ticker | Fecha | Precio | Peso |
| --- | ---: | ---: | ---: |
${rows.join("\n")}

${"nota ".repeat(800)}
`;
}

test("classifySourceDoc: dated log is extractive", () => {
  const content = buildLogDoc();
  const r = classifySourceDoc("🚀 Personal/💶 Wealth/bitácora-decisiones.md", content);
  assert.equal(r.extractive, true, JSON.stringify(r));
  assert.equal(r.reason, "log_reference_heuristic");
});

test("classifySourceDoc: table-heavy doc is extractive", () => {
  const content = buildTableDoc();
  const r = classifySourceDoc("🚀 Personal/💶 Wealth/portfolio.md", content);
  assert.equal(r.extractive, true, JSON.stringify(r));
});

test("classifySourceDoc: short prose is not extractive", () => {
  const r = classifySourceDoc(
    "notes/meeting.md",
    "---\ntitle: M\n---\n# Meeting\n\nTalked about roadmap with no numbers.\n"
  );
  assert.equal(r.extractive, false);
});

test("classifySourceDoc: skips when existing page retains well", () => {
  const content = buildLogDoc();
  const r = classifySourceDoc("🚀 Personal/💶 Wealth/bitácora-decisiones.md", content, {
    existingSourcePage: content
  });
  assert.equal(r.extractive, false, JSON.stringify(r));
  assert.match(r.reason, /existing_retention_ok/);
});

test("classifySourceDoc: WIKI_EXTRACTIVE_PATHS forces extractive", () => {
  const prev = process.env.WIKI_EXTRACTIVE_PATHS;
  process.env.WIKI_EXTRACTIVE_PATHS = "notes/forced.md";
  try {
    const r = classifySourceDoc("notes/forced.md", "short");
    assert.equal(r.extractive, true);
    assert.equal(r.reason, "forced_by_env");
  } finally {
    if (prev == null) delete process.env.WIKI_EXTRACTIVE_PATHS;
    else process.env.WIKI_EXTRACTIVE_PATHS = prev;
  }
});
