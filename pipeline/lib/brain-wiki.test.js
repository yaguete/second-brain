import test from "node:test";
import assert from "node:assert/strict";
import { chunkMarkdown, parseFrontmatter } from "./brain-wiki.js";

test("parseFrontmatter: scalar and quoted values", () => {
  const raw = `---
title: "Hello World"
type: source
created: 2026-05-01
---
Body here.
`;
  const { data, body } = parseFrontmatter(raw);
  assert.equal(data.title, "Hello World");
  assert.equal(data.type, "source");
  assert.equal(data.created, "2026-05-01");
  assert.match(body, /Body here/);
});

test("parseFrontmatter: inline array", () => {
  const raw = `---
title: X
tags: [a, b, "c d"]
---
`;
  const { data } = parseFrontmatter(raw);
  assert.deepEqual(data.tags, ["a", "b", "c d"]);
});

test("parseFrontmatter: empty inline array", () => {
  const raw = `---
tags: []
---
`;
  const { data } = parseFrontmatter(raw);
  assert.deepEqual(data.tags, []);
});

test("parseFrontmatter: multiline block sequence", () => {
  const raw = `---
title: Ana
sources:
  - 💼 Work/👤 People/Partners/Raw/Noa Lindqvist.md
  - "📒 Wiki/entities/entity-harbor-permits.md"
tags:
  - partner
  - grants
---
Prose.
`;
  const { data } = parseFrontmatter(raw);
  assert.equal(data.title, "Ana");
  assert.deepEqual(data.sources, [
    "💼 Work/👤 People/Partners/Raw/Noa Lindqvist.md",
    "📒 Wiki/entities/entity-harbor-permits.md"
  ]);
  assert.deepEqual(data.tags, ["partner", "grants"]);
});

test("parseFrontmatter: empty block sequence key with no items", () => {
  const raw = `---
title: Empty
sources:
tags: [x]
---
`;
  const { data } = parseFrontmatter(raw);
  assert.deepEqual(data.sources, []);
  assert.deepEqual(data.tags, ["x"]);
});

test("parseFrontmatter: quoted items in block sequence", () => {
  const raw = `---
sources:
  - "🚀 Personal/💶 Wealth/portfolio.md"
---
`;
  const { data } = parseFrontmatter(raw);
  assert.deepEqual(data.sources, ["🚀 Personal/💶 Wealth/portfolio.md"]);
});

test("chunkMarkdown: long preamble before first ## is split", () => {
  const para = "> línea de callout con detalle clínico y fechas 15/10/2026.\n".repeat(60);
  const preamble = Array.from({ length: 8 }, () => para).join("\n\n");
  const body = `${preamble}\n\n## Transcripciones\n\nTexto corto de la sección.\n`;
  const chunks = chunkMarkdown(body);
  assert.ok(preamble.length > 20_000);
  assert.ok(chunks.length > 2);
  for (const c of chunks) assert.ok(c.length <= 2500, `chunk de ${c.length} chars`);
  assert.ok(chunks[0].startsWith("# "));
  assert.equal(chunks.at(-1), "## Transcripciones\n\nTexto corto de la sección.");
});

test("chunkMarkdown: short preamble stays a single chunk", () => {
  const chunks = chunkMarkdown("Intro breve de la página.\n\n## Estado\n\nTodo bien por ahora.\n");
  assert.deepEqual(chunks, ["# Intro breve de la página.", "## Estado\n\nTodo bien por ahora."]);
});
