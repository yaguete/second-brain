import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractDailyUsefulContent,
  shouldSkipContent,
  MIN_DAILY_USEFUL_CHARS,
  MIN_SYNTHESIS_BYTES
} from "./wiki-daily-skip.js";

const DAILY = "🗓️ Daily notes/2026.08.17.md";

const TEMPLATE = `---
tags:
  - daily
date: 2026-09-04
---
# Hoy · viernes, 4 septiembre 2026

## Trabajo
- [ ] [ ]

## Personal
- [ ] [ ]

## Parking
- 

## Notas rápidas
- 

## Habit tracker

| Hábito          | No  | Si  | Horas |
| --------------- | --- | --- | ----- |
| Ejercicio       | [ ] | [ ] |       |

## Cierre del día
¿He explorado algo nuevo hoy?
- 

¿Qué es lo que he conseguido avanzar?
- 

¿Qué cuello de botella ha surgido?
- 

Una cosa que quiero llevarme a mañana
- 

No te olvides de /cierre-día:
- 
`;

const FUTURE_AGENDA_ONLY = `---
tags:
  - daily
date: 2026-09-04
---
# Hoy · viernes, 4 septiembre 2026

## Trabajo
- [ ] Sesión con [[Sam Okafor]] para tantear su participación como backup de [[Alex Rivera]] 
- [ ] Demo Kiosk en Feria del Muelle con [[Sam Okafor]] y [[Cati Nan]] (catchup; el email de la convo está en [[2026.08.04]]) 
- [ ] 1 to 1 Alex & [[Sam Okafor]] (feedback [[Noa Lindqvist]])
- [ ] 1 to 1 [[Noa Lindqvist]] & Alex (recuerda preguntarle qué tal ha ido su TFM)

## Personal
- [ ] [ ]

## Parking
- 

## Notas rápidas
- 

## Habit tracker

| Hábito | No | Si | Horas |
| ------ | -- | -- | ----- |
| Ejercicio | [ ] | [ ] | |

## Cierre del día
¿He explorado algo nuevo hoy?
- 

No te olvides de /cierre-día:
- 
`;

const AUG_17_WITH_RESCHEDULE = `---
tags:
  - daily
date: 2026-08-17
---
# Hoy · lunes, 17 agosto 2026

## Trabajo
- [<] Demo Kiosk en Feria del Muelle con [[Sam Okafor]] y [[Cati Nan]] (catchup; el email de la convo está en [[2026.08.04]]) --> lo he cambiado para la vuelta de mis vacaciones el [[2026.09.04]]

## Personal
- Flecos [[Tidepool]]:
	- [ ] Mover el avatar / configuración de usuario al sidebar en desktop
	- [ ] Crear un resumen del viaje con el total de costes accesible desde el header del panel de Mi viaje.
	- [ ] Crear el buzón de correo noa@example.com ([[Noa]] será mi Customer Success manager)
	- [ ] Seleccionar e implementar banners y CTA en 5 post de lacosmopolilla.com 
	- [ ] Configurar herramientas de monitorización (google analytics, etc.)
- [ ] Clase de inglés: Intercultural communication

## Parking
- 

## Notas rápidas
- De vacaciones (17 ago – 2 sep)

## Habit tracker

| Hábito | No | Si | Horas |
| ------ | -- | -- | ----- |
| Ejercicio | [ ] | [ ] | |

## Cierre del día
¿He explorado algo nuevo hoy?
- 

No te olvides de /cierre-día:
- 
`;

const DONE_TASKS = `---
date: 2026-08-13
---
# Hoy

## Trabajo
- [x] Update Pending Topics Pre-vacacion and Organization con [[Alex Rivera]] --> ver nota

## Personal
- [x] Clase de inglés: Resolving minor disputes
- [x] Spark (Sanitas Dental): cambio de fundas

## Notas rápidas
- [[Noa]] se ha tomado muy bien las medicinas, tanto por la mañana como por la noche.
`;

describe("extractDailyUsefulContent", () => {
  it("strips the empty Daily template to nothing", () => {
    assert.equal(extractDailyUsefulContent(TEMPLATE), "");
  });

  it("strips unchecked - [ ] tasks so future agenda does not count", () => {
    const useful = extractDailyUsefulContent(FUTURE_AGENDA_ONLY);
    assert.ok(useful.length < MIN_DAILY_USEFUL_CHARS, `got ${useful.length} chars: ${useful}`);
    assert.doesNotMatch(useful, /Noa/);
    assert.doesNotMatch(useful, /Sam Okafor/);
  });

  it("keeps [<] reschedule lines and prose, not the leftover - [ ] flecos", () => {
    const useful = extractDailyUsefulContent(AUG_17_WITH_RESCHEDULE);
    assert.match(useful, /Demo Kiosk/);
    assert.match(useful, /De vacaciones/);
    assert.match(useful, /Flecos/);
    assert.doesNotMatch(useful, /avatar/);
    assert.doesNotMatch(useful, /Clase de inglés/);
    assert.ok(useful.length >= MIN_DAILY_USEFUL_CHARS);
  });

  it("keeps [x] tasks", () => {
    const useful = extractDailyUsefulContent(DONE_TASKS);
    assert.match(useful, /Alex Rivera/);
    assert.match(useful, /Noa/);
  });
});

describe("shouldSkipContent", () => {
  it("skips empty template dailies as template_only", () => {
    const r = shouldSkipContent(DAILY, TEMPLATE);
    assert.equal(r.skip, true);
    assert.equal(r.reason, "template_only");
  });

  it("skips a future daily that is only unchecked agenda", () => {
    const r = shouldSkipContent("🗓️ Daily notes/2026.09.04.md", FUTURE_AGENDA_ONLY);
    assert.equal(r.skip, true);
    assert.equal(r.reason, "template_only");
  });

  it("does not skip 17 ago (reschedule + vacation note)", () => {
    const r = shouldSkipContent(DAILY, AUG_17_WITH_RESCHEDULE);
    assert.equal(r.skip, false);
  });

  it("does not skip a past daily with [x] and notes", () => {
    const r = shouldSkipContent("🗓️ Daily notes/2026.08.13.md", DONE_TASKS);
    assert.equal(r.skip, false);
  });

  it("skips non-daily sources under the byte floor", () => {
    const r = shouldSkipContent("💼 Work/nota.md", "hola");
    assert.equal(r.skip, true);
    assert.equal(r.reason, "too_small");
    assert.match(r.detail, new RegExp(String(MIN_SYNTHESIS_BYTES)));
  });

  it("does not skip a non-daily source above the byte floor", () => {
    const body = "x".repeat(MIN_SYNTHESIS_BYTES);
    const r = shouldSkipContent("💼 Work/nota.md", body);
    assert.equal(r.skip, false);
  });
});
