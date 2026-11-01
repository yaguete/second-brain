import test from "node:test";
import assert from "node:assert/strict";
import {
  extractVerbatimBody,
  buildExtractiveSourcePage
} from "./wiki-extractive-source.js";

test("extractVerbatimBody keeps tables and dated sections", () => {
  const body = `# Title

Intro fluff that should drop.

## 2026-08-06 — Decision

- **Amount:** 4.950 €

More fluff.

| A | B |
| - | - |
| 1 | 2 |

Trailing fluff.
`;
  const out = extractVerbatimBody(body);
  assert.match(out, /2026-08-06/);
  assert.match(out, /4\.950/);
  assert.match(out, /\| A \| B \|/);
  assert.doesNotMatch(out, /Intro fluff/);
  assert.doesNotMatch(out, /Trailing fluff/);
});

test("buildExtractiveSourcePage sets extractive frontmatter", () => {
  const md = buildExtractiveSourcePage({
    sourceRel: "🚀 Personal/💶 Wealth/portfolio.md",
    sourceContent: `---
title: Portfolio
tags: [wealth]
---
# Portfolio

| Ticker | ISIN |
| --- | --- |
| NVDA | US67066G1040 |
`,
    filename: "source-portfolio.md",
    title: "Portfolio"
  });
  assert.match(md, /extractive: true/);
  assert.match(md, /source_vault: "🚀 Personal\/💶 Wealth\/portfolio\.md"/);
  assert.match(md, /US67066G1040/);
  assert.match(md, /type: source/);
});
