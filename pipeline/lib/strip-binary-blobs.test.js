import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripBinaryBlobs } from "../../bridge/src/shared/utils.js";

describe("stripBinaryBlobs", () => {
  it("removes data URIs", () => {
    const b64 = "A".repeat(250);
    const md = `Hello\n![x](data:image/png;base64,${b64})\nWorld`;
    const { text, removed } = stripBinaryBlobs(md);
    assert.ok(removed > 200);
    assert.ok(text.includes("Hello"));
    assert.ok(text.includes("World"));
    assert.ok(text.includes("omitida") || text.includes("omitido"));
  });

  it("respects STRIP_BINARY_BLOBS=off", () => {
    const prev = process.env.STRIP_BINARY_BLOBS;
    process.env.STRIP_BINARY_BLOBS = "off";
    try {
      const b64 = "B".repeat(250);
      const md = `data:image/png;base64,${b64}`;
      const { text, removed } = stripBinaryBlobs(md);
      assert.equal(removed, 0);
      assert.equal(text, md);
    } finally {
      if (prev == null) delete process.env.STRIP_BINARY_BLOBS;
      else process.env.STRIP_BINARY_BLOBS = prev;
    }
  });
});
