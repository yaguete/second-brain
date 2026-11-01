import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEventsResponse, pickSuggestedConcept, pickLang } from "./newsapi.js";
import { extractPortfolioHoldings, formatHoldingsForSearch, daysSince } from "./monthly.js";

describe("newsapi parsers", () => {
  it("parses getEvents results", () => {
    const { events, total } = parseEventsResponse({
      events: {
        totalResults: 26,
        results: [
          {
            uri: "eng-12092902",
            eventDate: "2026-10-12",
            totalArticleCount: 67,
            title: { eng: "ZZZT Falls After Launch Debut Delayed to 2027", deu: "x" },
            summary: { eng: "ZZZT   again delayed the launch." }
          },
          { uri: "zho-1", eventDate: "2026-10-20", articleCounts: { total: 40 }, title: { zho: "SpaceX" }, summary: {} }
        ]
      }
    });
    assert.equal(total, 26);
    assert.deepEqual(events[0], {
      date: "2026-10-12",
      title: "ZZZT Falls After Launch Debut Delayed to 2027",
      article_count: 67,
      uri: "eng-12092902",
      summary: "ZZZT again delayed the launch."
    });
    assert.equal(events[1].title, "SpaceX");
    assert.equal(events[1].article_count, 40);
  });
  it("handles empty responses", () => {
    assert.deepEqual(parseEventsResponse({}), { events: [], total: null });
  });
  it("picks the org concept from suggest", () => {
    const r = pickSuggestedConcept([
      { uri: "http://en.wikipedia.org/wiki/Blackrock,_Dublin", type: "loc", label: { eng: "Blackrock, Dublin" } },
      { uri: "http://en.wikipedia.org/wiki/BlackRock", type: "org", label: { eng: "BlackRock" } }
    ]);
    assert.equal(r.uri, "http://en.wikipedia.org/wiki/BlackRock");
    assert.equal(pickSuggestedConcept([]), null);
    assert.equal(pickLang({ spa: "hola" }), "hola");
  });
});

describe("extractPortfolioHoldings", () => {
  const md = `## TR
| Ticker   | ISIN | Acciones | Precio med. | Tesis / nota |
| -------- | ---: | ---: | ---: | --- |
| ZZZT     | US0000000001 | 32 | 99€ | ejemplo, posición ancla |
| ZZZU     | US0000000002 | 27 | 35€ | ZZZU Labs, ejemplo. Ver [[bitácora-decisiones|bitácora]] |
| ~~SMCI~~ | ~~US86800U3023~~ | — | — | ❌ Vendido |

| ETF | ISIN | Acciones | Precio med. | Exposición |
| --- | ---: | ---: | ---: | --- |
| Big Tech | DE000SN8ZND9 | 684 | 1,8€ | Mag7-style |

| Valor | Activos | Precio med. | % |
| --- | ---: | ---: | ---: |
| Bitcoin | 0,02 | 79.909€ | 48% |

| Tipo | Acciones |
|---|---:|
| Brokerage | 34 |
`;
  it("keeps live rows from every table and skips sold ones", () => {
    const h = extractPortfolioHoldings(md);
    assert.deepEqual(h.map((x) => `${x.kind}:${x.ticker || x.name}`), [
      "stock:ZZZT", "stock:ZZZU", "etf:Big Tech", "crypto:Bitcoin"
    ]);
    assert.equal(h[1].name, "ZZZU Labs");
    assert.equal(h[1].isin, "US0000000002");
    assert.match(formatHoldingsForSearch(h), /ZZZU — ZZZU Labs, ejemplo\. Ver bitácora/);
  });
  it("handles missing portfolio", () => {
    assert.deepEqual(extractPortfolioHoldings(null), []);
  });
  it("daysSince", () => {
    assert.equal(daysSince("2026-10-01", new Date("2026-11-01T12:00:00Z")), 31);
  });
});
