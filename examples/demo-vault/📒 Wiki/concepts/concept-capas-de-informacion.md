---
title: "Capas de información"
type: concept
created: 2026-11-01
updated: 2026-11-01
sources:
  - "🚀 Personal/Learning/notas-de-lectura.md"
  - "📥 Inbox/articles/marea-de-octubre.md"
tags:
  - cartografía
  - visualización
  - diseño-de-información
  - tidepool
---

# Capas de información

## Definición operativa

Una capa cartográfica o visual debe representar una sola variable. Separar las variables permite interpretar cada dimensión sin mezclar señales, ruido contextual o datos de naturaleza diferente. Cuando dos conjuntos de datos responden a preguntas distintas, deben conservarse como capas independientes aunque se muestren dentro del mismo mapa.

## Aplicación en Tidepool

Este principio es relevante para el diseño de [[Tidepool]], el proyecto personal de [[Alex Rivera]] para crear un mapa de calas que muestre la altura de la marea. La información relacionada con un expediente, como [[Harbor Permits]], y la información sobre la marea deben mostrarse en capas diferenciadas. Mezclarlas en una única representación puede dificultar la lectura y hacer que el mapa resulte inútil.

La capa de mareas de [[Tidepool]] tiene como ejemplo un recorte del **02.10.2026**: la pleamar de esa mañana en una costa de ejemplo fue a las **08:40**, con un coeficiente **64**. El recorte no identifica un puerto real; esos datos están destinados a la capa de mareas de [[Tidepool]], no al expediente de [[Harbor Permits]]. Por tanto, el ejemplo ilustra tanto la separación entre variables como la separación entre contextos de información.

A fecha de **29.10.2026**, la capa de mareas todavía no tenía nombre y el siguiente paso pendiente era reservar una hora para elegirlo. La decisión de mantener [[Tidepool]] separado de [[Harbor Permits]] debe preservarse: los datos de mareas no deben incorporarse al expediente municipal.

## Origen

La idea fue registrada por [[Alex Rivera]] el **18.10.2026**, a partir de un capítulo sobre mapas costeros en [[🚀 Personal/Learning/notas-de-lectura]]. El recorte de marea del **02.10.2026** proporciona un ejemplo concreto para aplicar este principio en [[Tidepool]].

## See also

- [[Tidepool]]
- [[Harbor Permits]]
- [[Alex Rivera]]