import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractFacts, factRetention } from "./wiki-fact-retention.js";

describe("wiki-fact-retention", () => {
  it("extracts iso dates and money", () => {
    const facts = extractFacts("Paid 12.50 EUR on 2026-03-18 and visited https://example.com/x");
    assert.ok(facts.has("2026-03-18"));
    assert.ok([...facts.keys()].some((k) => k.includes("eur") || k.includes("12.50")));
    assert.ok([...facts.keys()].some((k) => k.includes("example.com")));
  });

  it("computes retention when facts survive", () => {
    const before = "Meeting on 2026-03-18 about Harbor Permits. Cost 100 EUR.";
    const after = "On 2026-03-18 we reviewed Harbor Permits; cost remains 100 EUR.";
    const { retention, total, lost } = factRetention(before, after);
    assert.ok(total >= 2);
    assert.equal(lost.length, 0);
    assert.equal(retention, 1);
  });

  it("detects lost facts", () => {
    const before = "Deadline 2026-08-01 and budget 500 €.";
    const after = "Deadline moved; no budget listed.";
    const { retention, lost } = factRetention(before, after);
    assert.ok(lost.length >= 1);
    assert.ok(retention < 1);
  });
});
