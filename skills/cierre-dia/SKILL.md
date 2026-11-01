---
name: cierre-dia
description: 'Cierre rápido del día: qué avanzó, qué se quedó colgado, correo personal, calendario y la daily de mañana. Usar cuando digan "cierre", "cómo fue hoy", "cerrar el día" o "wrap up".'
---

# Cierre del día

Cinco a diez líneas. Sin tablas. Si un dominio no aporta nada, se omite.

## Principio

Consultas en paralelo. Si una fuente falla, se sigue con el resto. No se recita el calendario entero. Solo lo anormal.

## Fechas

Zona `Europe/Madrid`. La jornada que se cierra es hoy, salvo entre las 00:00 y las 05:00, que cierra el día anterior. La daily se llama `YYYY.MM.DD.md`.

## Fuentes

Todas opcionales. Úsalas solo si el conector está instalado.

- Daily de la jornada y daily de mañana, en `🗓️ Daily notes/`.
- Checkboxes abiertos de `## Trabajo` y `## Personal` en la daily de mañana.
- Correo personal, si hay un MCP de correo. No listar la bandeja.
- Calendario, si hay un MCP de calendario.
- Trabajo en el tracker que la persona use (Linear u otro). No asumas un equipo.
- YNAB y Withings solo si esos módulos están encendidos. El presupuesto es `<BUDGET_ID>`, no un UUID inventado.

## Salida

Escribe el cierre únicamente bajo `No te olvides de /cierre-día:` de la daily de la jornada. No crees otra nota.

Líneas posibles, en este orden, omitiendo las vacías:

- Avanzó
- Colgado
- Mañana (una sola prioridad, cruzando calendario y checkboxes)
- Correo (una anomalía, o nada)
- Cuerpo (un dato, o nada)
