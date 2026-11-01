/** Unified extraction used at ingest + MCP fallback. Bump when prompt/schema changes. */
export const BILL_EXTRACT_PROMPT_VERSION = "v1";

export const BILL_EXTRACT_PROMPT = `You are a utility bill data extractor. Given the text of a utility bill (water, electricity, gas, or other), extract structured billing data in one pass.
Return JSON with this structure:
{
  "bill_type": "<agua|electricidad|gas|otro>",
  "date": "<YYYY-MM or null>",
  "total": <number or null>,
  "currency": "EUR",
  "subtotal_before_tax": <number or null>,
  "consumption": {
    "value": <number or null>,
    "unit": "<kWh|m³|litros|etc or null>",
    "period_start": "<date or null>",
    "period_end": "<date or null>"
  },
  "items": [
    { "concept": "<line item name>", "amount": <number> }
  ],
  "taxes": [
    { "concept": "<tax name, e.g. IVA, IEE>", "rate": "<percentage as string or null>", "amount": <number> }
  ],
  "details": [
    { "concept": "<e.g. horas punta, horas valle, potencia, caudal>", "value": <number>, "unit": "<unit>" }
  ]
}
Extract every line item you can find: energia at different rates (punta, llano, valle), potencia contratada, termino fijo, alquiler de equipos, canon, abono social, etc.
If you cannot find consumption data, set consumption.value/unit to null and details to [].
If you cannot determine an amount, use null. Always respond in Spanish for concept names.`;

/** @deprecated Prefer BILL_EXTRACT_PROMPT; kept for reference / legacy callers */
export const CONSUMPTION_PROMPT = `You are a utility bill data extractor. Given the text of a utility bill (water, electricity, or gas), extract the consumption data.
Return JSON with this structure:
{
  "source": "<filename>",
  "bill_type": "<agua|electricidad|gas|otro>",
  "date": "<YYYY-MM or null>",
  "consumption": {
    "value": <number>,
    "unit": "<kWh|m³|litros|etc>",
    "period_start": "<date or null>",
    "period_end": "<date or null>"
  },
  "details": [
    { "concept": "<e.g. horas punta, horas valle, potencia, caudal>", "value": <number>, "unit": "<unit>" }
  ]
}
If you cannot find consumption data, set consumption to null and details to []. Always respond in Spanish for concept names.`;

/** @deprecated Prefer BILL_EXTRACT_PROMPT */
export const BREAKDOWN_PROMPT = `You are a utility bill data extractor. Given the text of a utility bill, extract the full cost breakdown.
Return JSON with this structure:
{
  "source": "<filename>",
  "bill_type": "<agua|electricidad|gas|otro>",
  "date": "<YYYY-MM or null>",
  "total": <number>,
  "currency": "EUR",
  "subtotal_before_tax": <number or null>,
  "items": [
    { "concept": "<line item name>", "amount": <number> }
  ],
  "taxes": [
    { "concept": "<tax name, e.g. IVA, IEE>", "rate": "<percentage as string or null>", "amount": <number> }
  ]
}
Extract every line item you can find: energia consumed at different rates (punta, llano, valle), potencia contratada, termino fijo, alquiler de equipos, canon, abono social, etc.
If you cannot determine an amount, use null. Always respond in Spanish for concept names.`;

/** @deprecated Prefer BILL_EXTRACT_PROMPT */
export const CONSUMPTION_TREND_PROMPT = `You are a utility bill data extractor. Given the text of a utility bill, extract ONLY the main consumption figure.
Return JSON: { "value": <number or null>, "unit": "<kWh|m³|litros|etc>" }
If you cannot find consumption data, return { "value": null, "unit": null }.`;

/** @deprecated Prefer BILL_EXTRACT_PROMPT */
export const SPENDING_EXTRACT_PROMPT = `You are a utility bill data extractor. Given the text of a utility bill, extract ONLY the total amount.
Return JSON: { "total": <number or null>, "currency": "EUR" }
If you cannot determine the total, return { "total": null, "currency": "EUR" }.`;

/** @deprecated Prefer BILL_EXTRACT_PROMPT */
export const COMPARE_EXTRACT_PROMPT = `You are a utility bill data extractor. Given the text of a utility bill, extract consumption and total cost.
Return JSON:
{
  "total": <number or null>,
  "currency": "EUR",
  "consumption": { "value": <number or null>, "unit": "<kWh|m³|litros|etc or null>" }
}`;
