import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  stripFrontmatter,
  findPlaceholderLine,
  detectSuspiciousUpdate,
  detectSuspiciousCreate,
  detectOversizedPage
} from "./wiki-update-guard.js";

const EXISTING_ENTITY = `---
title: "Sam Okafor"
type: entity
created: "2024-01-01"
updated: "2025-05-01"
---

# Sam Okafor

## Perfil
Director de producto en Acme. Lidera el módulo de permisos desde 2023.

## Relación con el vault
Contacto clave en la integración del proyecto X. Reuniones recurrentes con el equipo de datos.

## Decisiones relevantes
- 2024-03-12: acordó priorizar la API v2 sobre el dashboard.
- 2024-09-04: propuso unificar criterios de reporting entre regiones.

## Contexto adicional
Mencionado en varias dailies como sponsor del roadmap Q3. Perfil técnico fuerte en backend.
`;

function repeatBlock(text, times) {
  return Array.from({ length: times }, () => text).join("\n\n");
}

describe("stripFrontmatter", () => {
  it("removes YAML frontmatter and keeps body", () => {
    const md = "---\ntitle: Foo\n---\n\n# Body\n";
    assert.equal(stripFrontmatter(md), "\n# Body\n");
  });

  it("returns input unchanged when no frontmatter", () => {
    assert.equal(stripFrontmatter("# Only body"), "# Only body");
  });
});

describe("findPlaceholderLine", () => {
  it("detects bracket placeholder line from Sam bug", () => {
    const body =
      "# Sam Okafor\n\n[existing content unchanged from the previous version, up to the end of the page]";
    assert.match(findPlaceholderLine(body), /existing content unchanged/i);
  });

  it("detects standalone ellipsis line", () => {
    assert.equal(findPlaceholderLine("Intro\n[...]\nOutro"), "[...]");
  });

  it("does not flag markdown link containing unchanged in link text", () => {
    const body = "See [unchanged policy notes](https://example.com/docs) for details.";
    assert.equal(findPlaceholderLine(body), null);
  });

  it("does not flag prose mentioning no changes inside a paragraph", () => {
    const body =
      "## Contradictions\n\nThere were no changes to the budget assumptions in this revision.";
    assert.equal(findPlaceholderLine(body), null);
  });
});

describe("detectSuspiciousUpdate", () => {
  let prevRatio;

  beforeEach(() => {
    prevRatio = process.env.WIKI_UPDATE_MIN_BODY_RATIO;
    delete process.env.WIKI_UPDATE_MIN_BODY_RATIO;
  });

  afterEach(() => {
    if (prevRatio === undefined) delete process.env.WIKI_UPDATE_MIN_BODY_RATIO;
    else process.env.WIKI_UPDATE_MIN_BODY_RATIO = prevRatio;
  });

  it("flags the literal Sam placeholder bug", () => {
    const merged =
      "# Sam Okafor\n\n[existing content unchanged from the previous version, up to the end of the page]";
    const result = detectSuspiciousUpdate(EXISTING_ENTITY, merged);
    assert.equal(result.suspicious, true);
    assert.match(result.reason, /placeholder marker line/i);
  });

  it("allows legitimate re-synthesis that condenses ~45% without placeholder", () => {
    const merged = stripFrontmatter(EXISTING_ENTITY)
      .split("\n")
      .filter((line) => !line.startsWith("- 2024-09"))
      .join("\n")
      .replace(/\s{2,}/g, " ");
    const paddedExisting = EXISTING_ENTITY + "\n\n" + repeatBlock("Nota histórica adicional.", 8);
    const result = detectSuspiciousUpdate(paddedExisting, merged);
    assert.equal(result.suspicious, false);
  });

  it("flags inline placeholder phrasing with moderate shrink", () => {
    const longExisting =
      EXISTING_ENTITY +
      "\n\n" +
      repeatBlock("Bloque de contexto extenso sobre reuniones, actas y seguimiento operativo.", 20);
    const merged = `---
title: "Sam Okafor"
type: entity
---

# Sam Okafor

${repeatBlock("Resumen condensado del perfil, relaciones clave y decisiones recientes con contexto operativo.", 6)}

The rest of the page remains unchanged from the previous version, including historical meeting notes and prior decisions.
`;
    const result = detectSuspiciousUpdate(longExisting, merged);
    assert.equal(result.suspicious, true);
    assert.match(result.reason, /moderate body shrink/i);
  });

  it("flags catastrophic shrink without placeholder line", () => {
    const merged = "# Sam Okafor\n\nResumen mínimo.";
    const result = detectSuspiciousUpdate(EXISTING_ENTITY, merged);
    assert.equal(result.suspicious, true);
    assert.match(result.reason, /catastrophic body shrink/i);
    assert.match(result.reason, /apply the edit manually/i);
  });

  it("flags Signal A only when page grows but a section is replaced by a marker line", () => {
    const merged = `---
title: "Sam Okafor"
type: entity
---

# Sam Okafor

## Perfil
Director de producto en Acme. Actualizado tras la reunión de junio.

## Relación con el vault
Nuevo párrafo con contexto reciente y enlaces a fuentes del vault.

## Decisiones relevantes
[sin cambios]

## Contexto adicional
Ampliado con detalle sobre el roadmap Q4 y nuevas dependencias del equipo.
`;
    const result = detectSuspiciousUpdate(EXISTING_ENTITY, merged);
    assert.equal(result.suspicious, true);
    assert.match(result.reason, /placeholder marker line/i);
    assert.doesNotMatch(result.reason, /moderate body shrink/i);
  });
});

describe("detectSuspiciousUpdate severity", () => {
  let prevMin;
  let prevAlert;

  beforeEach(() => {
    prevMin = process.env.WIKI_MIN_FACT_RETENTION;
    prevAlert = process.env.WIKI_ALERT_FACT_RETENTION;
    delete process.env.WIKI_MIN_FACT_RETENTION;
    delete process.env.WIKI_ALERT_FACT_RETENTION;
  });

  afterEach(() => {
    if (prevMin === undefined) delete process.env.WIKI_MIN_FACT_RETENTION;
    else process.env.WIKI_MIN_FACT_RETENTION = prevMin;
    if (prevAlert === undefined) delete process.env.WIKI_ALERT_FACT_RETENTION;
    else process.env.WIKI_ALERT_FACT_RETENTION = prevAlert;
  });

  /** Página con `count` fechas ISO únicas + relleno sin hechos duros. */
  function pageWithDates(count, fillerLines = 0) {
    const dates = Array.from(
      { length: count },
      (_, i) =>
        `- 2024-${String((i % 12) + 1).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}: hito registrado con detalle operativo.`
    );
    const filler = Array.from(
      { length: fillerLines },
      () => "Contexto narrativo adicional sobre el seguimiento del proyecto y su gobernanza."
    );
    return `---\ntitle: "Proyecto X"\ntype: entity\n---\n\n# Proyecto X\n\n## Hitos\n${dates.join("\n")}\n\n${filler.join("\n\n")}\n`;
  }

  it("marks ~85% fact retention as soft", () => {
    const existing = pageWithDates(20);
    const merged = pageWithDates(17, 6);
    const result = detectSuspiciousUpdate(existing, merged);
    assert.equal(result.suspicious, true);
    assert.equal(result.severity, "soft");
    assert.match(result.reason, /fact loss/i);
    assert.doesNotMatch(result.reason, /WIKI_MIN_FACT_RETENTION/);
  });

  it("marks ~30% fact retention as hard", () => {
    const existing = pageWithDates(20);
    const merged = pageWithDates(6, 24);
    const result = detectSuspiciousUpdate(existing, merged);
    assert.equal(result.suspicious, true);
    assert.equal(result.severity, "hard");
    assert.match(result.reason, /fact loss/i);
  });

  it("honours WIKI_ALERT_FACT_RETENTION to force hard", () => {
    process.env.WIKI_ALERT_FACT_RETENTION = "0.999";
    const result = detectSuspiciousUpdate(pageWithDates(20), pageWithDates(17, 6));
    assert.equal(result.severity, "hard");
  });

  it("marks placeholder and catastrophic shrink as hard", () => {
    const placeholder = detectSuspiciousUpdate(
      EXISTING_ENTITY,
      "# Sam Okafor\n\n[existing content unchanged from the previous version]"
    );
    assert.equal(placeholder.severity, "hard");

    const shrink = detectSuspiciousUpdate(EXISTING_ENTITY, "# Sam Okafor\n\nResumen mínimo.");
    assert.equal(shrink.severity, "hard");
  });

  it("returns null severity when nothing is suspicious", () => {
    const result = detectSuspiciousUpdate(pageWithDates(20), pageWithDates(20, 2));
    assert.equal(result.suspicious, false);
    assert.equal(result.severity, null);
  });
});

describe("detectSuspiciousCreate", () => {
  it("flags placeholder marker on create", () => {
    const md = "# New Entity\n\n[existing content unchanged]";
    const result = detectSuspiciousCreate(md);
    assert.equal(result.suspicious, true);
    assert.equal(result.severity, "hard");
  });

  it("allows normal create body", () => {
    const md = "# New Entity\n\nPerfil completo autocontenido.";
    assert.equal(detectSuspiciousCreate(md).suspicious, false);
  });
});

describe("detectOversizedPage", () => {
  it("hard-fails above the hard cap", () => {
    const md = "x".repeat(100_001);
    const r = detectOversizedPage(md, { hardCap: 100_000, warnChars: 25_000, pageLabel: "entities/big.md" });
    assert.equal(r.oversized, true);
    assert.equal(r.severity, "hard");
    assert.match(r.reason, /hard cap/);
  });

  it("soft-warns between warn target and hard cap", () => {
    const md = "x".repeat(30_000);
    const r = detectOversizedPage(md, { hardCap: 100_000, warnChars: 25_000 });
    assert.equal(r.oversized, true);
    assert.equal(r.severity, "soft");
    assert.match(r.reason, /split warn/);
  });

  it("allows pages under the warn target", () => {
    const md = "x".repeat(10_000);
    const r = detectOversizedPage(md, { hardCap: 100_000, warnChars: 25_000 });
    assert.equal(r.oversized, false);
    assert.equal(r.severity, null);
  });
});
