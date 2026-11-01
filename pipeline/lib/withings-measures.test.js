import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeWithingsMeasure, normalizeWithingsBodyMeasurements } from "../../bridge/src/modules/withings/measures.js";

describe("decodeWithingsMeasure", () => {
  it("decodes heart pulse (type 11) as bpm, not kg", () => {
    const d = decodeWithingsMeasure({ value: 104000, type: 11, unit: -3 });
    assert.equal(d.type_name, "heart_pulse");
    assert.equal(d.unit, "bpm");
    assert.equal(d.value, 104);
    assert.equal(d.is_body_composition, false);
  });

  it("decodes weight (type 1) as kg", () => {
    const d = decodeWithingsMeasure({ value: 78500, type: 1, unit: -3 });
    assert.equal(d.type_name, "weight");
    assert.equal(d.value, 78.5);
    assert.equal(d.is_body_composition, true);
  });
});

describe("normalizeWithingsBodyMeasurements", () => {
  it("separates weight from pulse and sets has_weight false when only pulse", () => {
    const raw = {
      measuregrps: [
        {
          date: 1780335064,
          model: "ScanWatch",
          measures: [{ value: 104000, type: 11, unit: -3 }]
        }
      ]
    };
    const n = normalizeWithingsBodyMeasurements(raw);
    assert.equal(n.has_weight, false);
    assert.equal(n.weight_readings.length, 0);
    assert.equal(n.other_readings.length, 1);
    assert.equal(n.other_readings[0].value, 104);
    assert.equal(n.other_readings[0].type_name, "heart_pulse");
    assert.match(n.note || "", /tipo 11/);
  });
});
