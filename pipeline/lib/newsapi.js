/**
 * Cliente mínimo de NewsAPI.ai (Event Registry) para el monthly, vía API REST.
 *
 * Por qué REST y no el MCP alojado (https://mcp.newsapi.ai/mcp): ese servidor solo acepta
 * tokens OAuth (JWT de auth.id.eventregistry.org, ver /.well-known/oauth-protected-resource/mcp);
 * rechaza la API key ("Invalid Compact JWS"). La REST sirve los mismos datos con la API key.
 */

export const DEFAULT_NEWSAPI_BASE_URL = "https://eventregistry.org/api/v1";

/**
 * Ticker → concepto de Event Registry (URI de Wikipedia).
 * El mapa de serie va vacío: cada instalación lo rellena con MONTHLY_NEWSAPI_CONCEPTS
 * (JSON {"TICKER": "http://en.wikipedia.org/wiki/..." | [uri, uri]}).
 * Si un ticker no está en el mapa, el cliente busca por nombre.
 */
export const NEWSAPI_TICKER_CONCEPTS = {};

/** Texto en eng > spa > el primero disponible. @param {unknown} v */
export function pickLang(v) {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object") return "";
  return v.eng || v.spa || Object.values(v).find((x) => typeof x === "string") || "";
}

/** @param {unknown} json @param {number} [summaryChars] */
export function parseEventsResponse(json, summaryChars = 400) {
  const block = json?.events;
  const results = Array.isArray(block?.results) ? block.results : [];
  const events = results.map((e) => {
    const summary = pickLang(e.summary).replace(/\s+/g, " ").trim();
    return {
      date: e.eventDate || null,
      title: pickLang(e.title).trim(),
      article_count: e.totalArticleCount ?? e.articleCounts?.total ?? null,
      uri: e.uri,
      summary: summary.length > summaryChars ? `${summary.slice(0, summaryChars - 1)}…` : summary
    };
  });
  return { events, total: block?.totalResults ?? null };
}

/** Primer concepto de tipo org (o el primero) de suggestConceptsFast. @param {unknown} json */
export function pickSuggestedConcept(json) {
  const rows = Array.isArray(json) ? json : [];
  const row = rows.find((r) => r?.type === "org") || rows[0];
  return row?.uri ? { uri: row.uri, label: pickLang(row.label) } : null;
}

/**
 * @param {{ apiKey: string, baseUrl?: string, timeoutMs?: number }} opts
 */
export function createNewsApiClient({ apiKey, baseUrl = DEFAULT_NEWSAPI_BASE_URL, timeoutMs = 60_000 }) {
  async function request(path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, apiKey }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      // Event Registry devuelve texto plano en errores de auth.
      throw new Error(text.slice(0, 200) || `HTTP ${res.status}`);
    }
    if (!res.ok || json?.error) throw new Error(json?.error || `HTTP ${res.status}`);
    return json;
  }

  return {
    async suggestConcept(name) {
      return pickSuggestedConcept(await request("/suggestConceptsFast", { prefix: name, lang: "eng" }));
    },
    /**
     * 5 tokens por llamada (dentro de los últimos 31 días).
     * Orden por relevancia, no por tamaño: con "size" las empresas grandes (NVDA, AAPL, SpaceX)
     * devolvían los macroeventos que solo las mencionan (bolsa de Taiwán, Ucrania…).
     * @param {{ conceptUri: string | string[], dateStart: string, dateEnd: string, count?: number, lang?: string }} q
     */
    async topEvents({ conceptUri, dateStart, dateEnd, count = 5, lang = "eng" }) {
      const json = await request("/event/getEvents", {
        conceptUri,
        ...(Array.isArray(conceptUri) ? { conceptOper: "or" } : {}),
        ...(lang ? { lang } : {}),
        dateStart,
        dateEnd,
        resultType: "events",
        eventsSortBy: "rel",
        eventsCount: count,
        eventsPage: 1,
        includeEventSummary: true,
        includeEventArticleCounts: true
      });
      return parseEventsResponse(json);
    },
    /** Gratis. @returns {Promise<{ availableTokens?: number, usedTokens?: number } | null>} */
    async usage() {
      try {
        return await request("/usage", {});
      } catch {
        return null;
      }
    }
  };
}
