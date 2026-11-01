import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  archiveOldOneOnOnes,
  normalizeOneOnOneHeadings,
  oneOnOnePageSkeleton,
  oneOnOnePages,
  oneOnOneUpdateReason,
  parseOneOnOneSource
} from "./wiki-one-on-ones.js";

const NOTE = `---
tipo: 1-1
persona: "[[Sam Okafor]]"
fecha: 2026-10-06
---

# 1-1 con [[Sam Okafor]] · 06.10.2026
`;

describe("parseOneOnOneSource / oneOnOnePages", () => {
  it("lee persona y fecha de la nota de 1:1", () => {
    assert.deepEqual(parseOneOnOneSource(NOTE), { persona: "Sam Okafor", fecha: "2026-10-06" });
    assert.equal(parseOneOnOneSource("---\ntipo: daily\n---\nx"), null);
    assert.equal(parseOneOnOneSource("sin frontmatter"), null);
  });

  it("deriva los nombres de página sin tildes", () => {
    assert.deepEqual(oneOnOnePages("Noa Lindqvist"), {
      hub: "entity-noa-lindqvist",
      page: "entity-noa-lindqvist-1-1s.md"
    });
    assert.match(oneOnOneUpdateReason({ persona: "X", fecha: "2026-10-06" }, "source-x.md"), /### 1-1 06\.10\.2026/);
  });
});

describe("archiveOldOneOnOnes", () => {
  const opts = (dirPath) => ({
    dirPath,
    filename: "entity-sam-okafor-1-1s.md",
    sourcePrefix: "📒 Wiki/entities",
    today: "2026-10-20"
  });
  const page = () =>
    oneOnOnePageSkeleton({ persona: "Sam Okafor", hub: "entity-sam-okafor", today: "2026-10-20" }).replace(
      "## 1:1s\n",
      "## 1:1s\n\n### 1-1 04.05.2026\n\nmayo\n\n### 1-1 13.07.2026\n\njulio\n\n### 1-1 27.07.2026\n\nfinal de julio\n\n### 1-1 06.10.2026\n\noctubre\n"
    );

  it("archiva por trimestre lo anterior a tres meses y enlaza los archivos", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-1on1-"));
    const out = archiveOldOneOnOnes(page(), opts(dir));

    assert.doesNotMatch(out, /\nmayo\n|\njulio\n/);
    assert.match(out, /### 1-1 27\.07\.2026\n\nfinal de julio/);
    assert.match(out, /### 1-1 06\.10\.2026\n\noctubre/);
    assert.match(out, /## Archivo\n\n- \[\[entity-sam-okafor-1-1s-2026-q2\|Q2 2026\]\]\n- \[\[entity-sam-okafor-1-1s-2026-q3\|Q3 2026\]\]/);

    const q2 = fs.readFileSync(path.join(dir, "entity-sam-okafor-1-1s-2026-q2.md"), "utf8");
    assert.match(q2, /title: "Sam Okafor — 1:1s \(Q2 2026\)"/);
    assert.match(q2, /## 1:1s\n\n### 1-1 04\.05\.2026\n\nmayo\n\n## See also/);
    assert.match(fs.readFileSync(path.join(dir, "entity-sam-okafor-1-1s-2026-q3.md"), "utf8"), /julio/);
  });

  it("es idempotente y mantiene el orden por fecha en el archivo", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-1on1-"));
    archiveOldOneOnOnes(page(), opts(dir));
    const again = archiveOldOneOnOnes(
      page().replace("### 1-1 04.05.2026", "### 1-1 18.05.2026\n\nsegunda de mayo\n\n### 1-1 04.05.2026"),
      opts(dir)
    );
    const q2 = fs.readFileSync(path.join(dir, "entity-sam-okafor-1-1s-2026-q2.md"), "utf8");
    assert.equal(q2.split("### 1-1 04.05.2026").length, 2);
    assert.ok(q2.indexOf("04.05.2026") < q2.indexOf("18.05.2026"));
    assert.equal(again.split("1-1s-2026-q2|").length, 2, "enlace sin duplicar");
  });

  it("no toca otras páginas ni páginas sin entradas antiguas", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-1on1-"));
    assert.equal(archiveOldOneOnOnes(page(), { ...opts(dir), filename: "entity-sam-okafor.md" }), page());
    const recent = page().replace(/### 1-1 (04\.05|13\.07)\.2026\n\n\w+\n\n/g, "");
    assert.equal(archiveOldOneOnOnes(recent, opts(dir)), recent);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

describe("normalizeOneOnOneHeadings", () => {
  const norm = (h, fn = "entity-a-1-1s.md") => normalizeOneOnOneHeadings(`## 1:1s\n\n${h}\n\nx\n`, fn).split("\n")[2];
  it("lleva los títulos fechados al formato canónico", () => {
    assert.equal(norm("### 2026-10-02 — Pivot de Build"), "### 1-1 02.10.2026 — Pivot de Build");
    assert.equal(norm("### 1:1 del 6/10/2026"), "### 1-1 06.10.2026");
    assert.equal(norm("### 1-1 con Xavier · 15.10.2026"), "### 1-1 15.10.2026");
  });
  it("no toca títulos ya canónicos, sin fecha, ni otras páginas", () => {
    assert.equal(norm("### 1-1 02.10.2026 — ok"), "### 1-1 02.10.2026 — ok");
    assert.equal(norm("### Notas sueltas"), "### Notas sueltas");
    assert.equal(norm("### 2026-10-02 — x", "entity-a.md"), "### 2026-10-02 — x");
  });
});

describe("normalizeOneOnOneHeadings — Archivo", () => {
  it("deja en ## Archivo solo los enlaces a archivos trimestrales", () => {
    const md = "## 1:1s\n\n### 1-1 06.10.2026\n\nx\n\n## Archivo\n\nProsa del LLM con [[entity-a-log]].\n- [[entity-a-1-1s-2026-q2|Q2 2026]]\n\n## See also\n\n- [[entity-a]]\n";
    const out = normalizeOneOnOneHeadings(md, "entity-a-1-1s.md");
    assert.match(out, /## Archivo\n\n- \[\[entity-a-1-1s-2026-q2\|Q2 2026\]\]\n\n## See also/);
    assert.doesNotMatch(out, /Prosa/);
  });
});
