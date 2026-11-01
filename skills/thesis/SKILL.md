---
name: thesis
description: 'Contrasta una tesis de inversión con lo que la wiki dice hoy. Usar cuando pidan "thesis [ticker]" o "cómo va la tesis de [nombre]".'
---

# Tesis

La tesis vive en la wiki. Esta skill no trae precios de fuera si no hay un conector de mercado, y no inventa una cartera.

## Pasos

1. Busca la página de la tesis y la tabla `lookup` de posiciones. Si no existen, para y dilo.
2. Lee solo las cifras que la página ya tiene: unidades, precio medio, fecha.
3. Si hay un conector de mercado (Finnhub u otro), pide el último precio del ticker que la página nombre. Si no hay conector, la sección de mercado dice "sin dato".
4. Separa dato y lectura, igual que el informe mensual.

Marcadores, vacíos hasta que la persona los rellene: `<PORTFOLIO_PAGE>`, `<BROKER_ACCOUNT_ID>`. No pongas un UUID ni un ticker que no esté en la wiki.

La salida es un comentario en el chat, salvo que pidan guardarlo como página `synthesis`.
