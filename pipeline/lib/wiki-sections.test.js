import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseMarkdownSections,
  serializeMarkdownSections,
  applySectionPatch,
  selectSectionsForPrompt,
  findSectionIndex,
  countH2,
  sectionOutline,
  snapshotKey,
  rotateDatedSnapshots
} from "./wiki-sections.js";

const PAGE = `---
title: "Tidepool"
type: entity
updated: 2026-08-01
---

Intro del hub.

## El problema que resuelve

Texto del problema.

## Estado actual (agosto 2026)

Backlog viejo.

## Ver también

- [[entity-alex-rivera]]
`;

describe("parseMarkdownSections", () => {
  it("keeps frontmatter, preamble and ## bodies", () => {
    const p = parseMarkdownSections(PAGE);
    assert.match(p.fm, /title: "Tidepool"/);
    assert.equal(p.preamble, "Intro del hub.");
    assert.equal(p.sections.length, 3);
    assert.equal(p.sections[1].title, "Estado actual (agosto 2026)");
    assert.match(p.sections[1].body, /Backlog viejo/);
  });
});

describe("applySectionPatch", () => {
  it("replaces one section and leaves the others byte-identical", () => {
    const patched = applySectionPatch(PAGE, {
      section: "Estado actual (agosto 2026)",
      markdown: "## Estado actual (agosto 2026)\n\nBacklog nuevo: thumbnails híbridos."
    });
    const p = parseMarkdownSections(patched);
    assert.equal(p.sections.length, 3);
    assert.match(p.sections[1].body, /thumbnails híbridos/);
    assert.equal(p.sections[0].body, parseMarkdownSections(PAGE).sections[0].body);
    assert.equal(p.sections[2].body, parseMarkdownSections(PAGE).sections[2].body);
    assert.match(patched, /title: "Tidepool"/);
    assert.match(patched, /Intro del hub/);
  });

  it("inserts a new section before See also", () => {
    const patched = applySectionPatch(PAGE, {
      section: "Coste de thumbnails",
      markdown: "## Coste de thumbnails\n\nWikimedia para hitos."
    });
    const titles = parseMarkdownSections(patched).sections.map((s) => s.title);
    assert.deepEqual(titles, [
      "El problema que resuelve",
      "Estado actual (agosto 2026)",
      "Coste de thumbnails",
      "Ver también"
    ]);
  });

  it("matches section titles without exact accents/casing", () => {
    const patched = applySectionPatch(PAGE, {
      section: "estado actual",
      markdown: "Solo el cuerpo, sin heading."
    });
    assert.match(patched, /Solo el cuerpo/);
    assert.equal(parseMarkdownSections(patched).sections.length, 3);
  });
});

describe("selectSectionsForPrompt", () => {
  it("prefers the named section and estado actual", () => {
    const sections = parseMarkdownSections(PAGE).sections;
    const picked = selectSectionsForPrompt(sections, "registrar avance del backlog", {
      preferredTitle: "Estado actual (agosto 2026)",
      maxSections: 2
    });
    assert.equal(picked[0].title, "Estado actual (agosto 2026)");
  });
});

describe("helpers", () => {
  it("countH2 ignores ###", () => {
    assert.equal(countH2("## Uno\n### nested\n## Dos"), 2);
  });

  it("round-trips serialize", () => {
    const p = parseMarkdownSections(PAGE);
    const out = serializeMarkdownSections(p);
    assert.equal(parseMarkdownSections(out).sections.length, 3);
    assert.match(out, /Intro del hub/);
  });

  it("findSectionIndex locates by normalized title", () => {
    const sections = parseMarkdownSections(PAGE).sections;
    assert.equal(findSectionIndex(sections, "ver tambien"), 2);
  });

  it("sectionOutline lists titles", () => {
    assert.match(sectionOutline(parseMarkdownSections(PAGE).sections), /Estado actual/);
  });
});

describe("snapshotKey / rotateDatedSnapshots", () => {
  it("reconoce los dos formatos de título fechado", () => {
    assert.deepEqual(snapshotKey("Bancos y estado (a 1/10/2026)"), {
      base: snapshotKey("Bancos y estado (a 18/10/2026)").base,
      date: "2026-10-01",
      month: "octubre"
    });
    assert.equal(snapshotKey("Estado a 7 de septiembre de 2026 (reagendamiento)").date, "2026-09-07");
    assert.deepEqual(snapshotKey("Estado actual (a 24 de agosto de 2026)"), {
      base: snapshotKey("Estado actual (a 12 de octubre de 2026)").base,
      date: "2026-08-24",
      month: "agosto"
    });
    assert.equal(snapshotKey("Estado actual"), null);
    assert.equal(snapshotKey("Hitos y plazos"), null);
  });

  it("deja solo la foto más reciente y devuelve las anteriores", () => {
    const md = `---
title: "Hipoteca"
---

Intro.

## Cifras

x

## Bancos y estado (a 18/10/2026)

viejo

## Bancos y estado (a 19/10/2026)

nuevo

## See also

- [[a]]
`;
    const { md: out, archived } = rotateDatedSnapshots(md);
    assert.deepEqual(
      archived.map((a) => [a.title, a.month]),
      [["Bancos y estado (a 18/10/2026)", "octubre"]]
    );
    assert.match(archived[0].body, /viejo/);
    assert.doesNotMatch(out, /viejo/);
    assert.match(out, /## Bancos y estado \(a 19\/10\/2026\)\n\nnuevo/);
    assert.match(out, /## Cifras/);
  });

  it("sin series repetidas no cambia nada", () => {
    const md = "## Estado actual\n\nhoy\n\n## Bancos y estado (a 18/10/2026)\n\nx\n";
    const r = rotateDatedSnapshots(md);
    assert.equal(r.md, md);
    assert.equal(r.archived.length, 0);
  });
});
