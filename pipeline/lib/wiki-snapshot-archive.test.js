import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { archiveDatedSnapshots } from "./wiki-snapshot-archive.js";

const HUB = `---
title: "Hipoteca Puerto Alto"
type: entity
---

# Hipoteca Puerto Alto

## Cifras

175.000 €

## Bancos y estado (a 18/10/2026)

foto del 18

## Páginas hijas

- [[entity-hipoteca-cronologia-octubre|Hipoteca — cronología (octubre 2026)]]

## Bancos y estado (a 2/11/2026)

foto del 2 de noviembre

## See also

- [[entity-bbva]]
`;

const OCTUBRE = `---
title: "Hipoteca — cronología (octubre 2026)"
type: entity
updated: 2026-10-19
---

# Hipoteca — cronología (octubre 2026)

## Bancos y estado (a 17/10/2026)

foto del 17

## See also

- [[entity-hipoteca]]
`;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wiki-archive-"));
}

const opts = (dirPath) => ({
  dirPath,
  filename: "entity-hipoteca.md",
  sourcePrefix: "📒 Wiki/entities",
  today: "2026-11-02"
});

describe("archiveDatedSnapshots", () => {
  it("mueve la foto antigua a la cronología de su mes y deja la última en el hub", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "entity-hipoteca-cronologia-octubre.md"), OCTUBRE);
    const out = archiveDatedSnapshots(HUB, opts(dir));

    assert.doesNotMatch(out, /foto del 18/);
    assert.match(out, /## Bancos y estado \(a 2\/11\/2026\)\n\nfoto del 2 de noviembre/);
    const oct = fs.readFileSync(path.join(dir, "entity-hipoteca-cronologia-octubre.md"), "utf8");
    assert.match(oct, /updated: 2026-11-02/);
    assert.ok(oct.indexOf("foto del 17") < oct.indexOf("foto del 18"), "orden cronológico");
    assert.ok(oct.indexOf("foto del 18") < oct.indexOf("## See also"), "antes de See also");

    // idempotente: volver a archivar la misma foto no la duplica
    archiveDatedSnapshots(HUB, opts(dir));
    const again = fs.readFileSync(path.join(dir, "entity-hipoteca-cronologia-octubre.md"), "utf8");
    assert.equal(again.split("foto del 18").length, 2);
  });

  it("crea la cronología de un mes nuevo y la enlaza en Páginas hijas", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "entity-hipoteca-cronologia-octubre.md"), OCTUBRE);
    const hub = HUB.replace("## Bancos y estado (a 18/10/2026)\n\nfoto del 18\n\n", "").replace(
      "## See also",
      "## Bancos y estado (a 3/12/2026)\n\nfoto de diciembre\n\n## See also"
    );
    const out = archiveDatedSnapshots(hub, opts(dir));

    const nov = fs.readFileSync(path.join(dir, "entity-hipoteca-cronologia-noviembre.md"), "utf8");
    assert.match(nov, /title: "Hipoteca — cronología \(noviembre 2026\)"/);
    assert.match(nov, /foto del 2 de noviembre/);
    assert.match(out, /- \[\[entity-hipoteca-cronologia-noviembre\|Hipoteca — cronología \(noviembre 2026\)\]\]/);
    assert.match(out, /foto de diciembre/);
    assert.doesNotMatch(out, /foto del 2 de noviembre/);
  });

  it("crea Páginas hijas con línea en blanco tras el título", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "entity-hipoteca-cronologia-octubre.md"), OCTUBRE);
    const hub = HUB.replace(/## Páginas hijas\n\n- \[\[[^\n]*\n\n/, "").replace(
      "## See also",
      "## Bancos y estado (a 3/12/2026)\n\nfoto de diciembre\n\n## See also"
    );
    const out = archiveDatedSnapshots(hub, opts(dir));
    assert.match(out, /## Páginas hijas\n\n- \[\[entity-hipoteca-cronologia-noviembre/);
  });

  it("sin páginas de cronología no toca nada", () => {
    const dir = tmpDir();
    assert.equal(archiveDatedSnapshots(HUB, opts(dir)), HUB);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});
