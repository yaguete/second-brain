import { test } from "node:test";
import assert from "node:assert/strict";
import { findOneOnOnes, upsertPrepBlock, tomorrowIso, dailyFilename, BLOCK_START, BLOCK_END } from "./prep-121.js";

const DAILY = `---
tags:
  - daily
---
# Hoy · martes, 29 septiembre 2026

## Trabajo
- [ ] Weekly // AEC Sandbox
- [ ] 1 to 1 [[Sam Okafor]] & Alex
- [<] ~~1 to 1 [[Noa Lindqvist]] & Alex~~ (reagendado)
- [x] 1 to 1 [[Sam Okafor]] & Alex
- [-] 1 to 1 [[Noa Lindqvist]] & Alex
- [ ] 1:1 Alex & [[Alex Rivera]]

## Personal
- [ ] 1 to 1 con nadie (esto es Personal)

## Notas rápidas
- 

## Habit tracker
`;

test("findOneOnOnes: solo pendientes de Trabajo, sin tachados ni hechos/cancelados", () => {
  const r = findOneOnOnes(DAILY);
  assert.deepEqual(r.map((x) => x.people), [["Sam Okafor"], ["Alex Rivera"]]);
});

test("findOneOnOnes: daily sin 1:1", () => {
  assert.equal(findOneOnOnes("## Trabajo\n- [ ] Weekly\n").length, 0);
});

test("upsertPrepBlock: inserta bajo Notas rápidas y conserva el resto", () => {
  const out = upsertPrepBlock(DAILY, "## 1:1 con Sam\n- punto", { generatedAt: "28/09 19:56" });
  const notes = out.split("## Notas rápidas")[1].split("## Habit tracker")[0];
  assert.ok(notes.includes(BLOCK_START) && notes.includes(BLOCK_END));
  assert.ok(notes.includes("#### 1:1 con Sam"));
  assert.ok(out.includes("## Habit tracker"));
  assert.ok(out.includes("- [ ] 1 to 1 [[Sam Okafor]] & Alex"));
});

test("upsertPrepBlock: idempotente (reemplaza, no duplica)", () => {
  const once = upsertPrepBlock(DAILY, "## 1:1 con A\n- v1", { generatedAt: "t1" });
  const twice = upsertPrepBlock(once, "## 1:1 con A\n- v2", { generatedAt: "t2" });
  assert.equal(twice.split(BLOCK_START).length - 1, 1);
  assert.ok(twice.includes("- v2") && !twice.includes("- v1"));
});

test("upsertPrepBlock: crea la sección si no existe", () => {
  const out = upsertPrepBlock("## Trabajo\n- [ ] x\n", "texto", { generatedAt: "t" });
  assert.ok(out.includes("## Notas rápidas\n" + BLOCK_START));
});

test("tomorrowIso y dailyFilename en Europe/Madrid", () => {
  // 28/09/2026 23:30 en Madrid = 21:30 UTC
  assert.equal(tomorrowIso(new Date("2026-09-28T21:30:00Z")), "2026-09-29");
  // 28/09/2026 00:30 en Madrid = 27/09 22:30 UTC
  assert.equal(tomorrowIso(new Date("2026-09-27T22:30:00Z")), "2026-09-29");
  assert.equal(dailyFilename("2026-09-29"), "2026.09.29.md");
});
