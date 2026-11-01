import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  resolveTargetMonth,
  getPreviousMonth,
  getMonthRange,
  getNetWorthSinceMonth,
  spanishMonthName,
  buildBaseFilename,
  resolveOutputPath,
  discoverInboxDir,
  isDateInRange,
  truncateText,
  buildContextManifest,
  sourceOk,
  sourceError,
  estimateTokens,
  estimateCostUsd,
  buildOutputMarkdown,
  filterDocumentsForMonth,
  findPreviousDocument,
  listDocsTouchedInMonth
} from "./monthly.js";

describe("resolveTargetMonth", () => {
  it("returns previous calendar month from execution date", () => {
    assert.equal(resolveTargetMonth(undefined, new Date("2026-07-15")), "2026-06");
    assert.equal(resolveTargetMonth(undefined, new Date("2026-01-10")), "2025-12");
  });

  it("accepts explicit --month", () => {
    assert.equal(resolveTargetMonth("2026-03"), "2026-03");
  });

  it("rejects invalid month", () => {
    assert.throws(() => resolveTargetMonth("2026-13"), /inválido/);
  });
});

describe("month ranges", () => {
  it("computes since/until for a month", () => {
    assert.deepEqual(getMonthRange("2026-06"), {
      month: "2026-06",
      since: "2026-06-01",
      until: "2026-06-30"
    });
  });

  it("computes previous month across year boundary", () => {
    assert.equal(getPreviousMonth("2026-01"), "2025-12");
    assert.equal(getPreviousMonth("2026-06"), "2026-05");
  });

  it("computes net worth window", () => {
    const w = getNetWorthSinceMonth("2026-06", 6);
    assert.equal(w.since, "2026-01-01");
    assert.equal(w.until, "2026-06-30");
  });
});

describe("spanishMonthName and filenames", () => {
  it("maps month to Spanish name", () => {
    assert.equal(spanishMonthName("2026-06"), "junio");
    assert.equal(buildBaseFilename("2026-06"), "monthly-2026-06-junio.md");
  });
});

describe("discoverInboxDir", () => {
  it("uses explicit INBOX_DIR", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
    const inbox = path.join(tmp, "custom-inbox");
    fs.mkdirSync(inbox, { recursive: true });
    assert.equal(discoverInboxDir(tmp, "custom-inbox"), inbox);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("finds exact emoji inbox folder", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
    const inbox = path.join(tmp, "📥 Inbox");
    fs.mkdirSync(inbox, { recursive: true });
    assert.equal(discoverInboxDir(tmp), inbox);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("throws on ambiguous inbox candidates", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
    fs.mkdirSync(path.join(tmp, "📥 Inbox A"));
    fs.mkdirSync(path.join(tmp, "📥 Inbox B"));
    assert.throws(() => discoverInboxDir(tmp), /ambiguo/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("resolveOutputPath idempotency", () => {
  it("picks -v2 when base exists", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-"));
    const first = resolveOutputPath(tmp, "2026-06");
    fs.writeFileSync(first.path, "existing");
    const second = resolveOutputPath(tmp, "2026-06");
    assert.equal(second.version, 2);
    assert.match(second.filename, /-v2\.md$/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("isDateInRange", () => {
  it("matches filename dates inside range", () => {
    assert.equal(isDateInRange("🗓️ Daily notes/2026/06 junio/2026.06.15.md", "2026-06-01", "2026-06-30"), true);
    assert.equal(isDateInRange("🗓️ Daily notes/2026/06 junio/2026.07.01.md", "2026-06-01", "2026-06-30"), false);
  });
});

describe("truncateText", () => {
  it("truncates long content with marker", () => {
    const r = truncateText("a".repeat(100), 50);
    assert.equal(r.truncated, true);
    assert.match(r.text, /truncado/);
  });
});

describe("buildContextManifest", () => {
  it("aggregates ok/empty/error counts", () => {
    const m = buildContextManifest({
      a: sourceOk("a", { x: 1 }),
      b: sourceOk("b", []),
      c: sourceError("c", "timeout")
    });
    assert.equal(m.ok, 1);
    assert.equal(m.empty, 1);
    assert.equal(m.errors, 1);
    assert.equal(m.error_details.length, 1);
  });
});

describe("document helpers", () => {
  const docs = [
    { source: "a.pdf", document_type: "factura_agua", document_date: "2026-05" },
    { source: "b.pdf", document_type: "factura_agua", document_date: "2026-06" },
    { source: "c.pdf", document_type: "factura_luz", document_date: "2026-06" }
  ];

  it("filters documents for month", () => {
    assert.equal(filterDocumentsForMonth(docs, "2026-06").length, 2);
  });

  it("finds previous document of same type", () => {
    const prev = findPreviousDocument(docs, "factura_agua", "2026-06");
    assert.equal(prev?.source, "a.pdf");
  });
});

describe("buildOutputMarkdown", () => {
  it("includes only date and month in frontmatter", () => {
    const md = buildOutputMarkdown("2026-06", "# Informe\n\nTexto.");
    assert.match(md, /^---\ndate: \d{4}-\d{2}-\d{2}\nmonth: 2026-06\n---\n/);
    assert.doesNotMatch(md, /generated_by/);
    assert.doesNotMatch(md, /^model:/m);
  });
});

describe("listDocsTouchedInMonth", () => {
  it("returns only docs with mtime in range, excluding archive and explicit paths", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "monthly-touched-"));
    const mk = (rel, mtime) => {
      const full = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, "contenido");
      fs.utimesSync(full, mtime, mtime);
    };
    const june = new Date("2026-06-15T12:00:00");
    const may = new Date("2026-05-10T12:00:00");
    mk("🚀 Personal/💶 Wealth/objetivos.md", june);
    mk("🚀 Personal/🩷 Friends & Family/Noa.md", june);
    mk("🚀 Personal/🗂️ Archive/viejo.md", june);
    mk("💼 Work/notas.md", may);

    const out = listDocsTouchedInMonth(tmp, "2026-06-01", "2026-06-30", {
      excludeRelPaths: ["🚀 Personal/💶 Wealth/objetivos.md"]
    });
    const rels = out.map((d) => d.relPath);
    assert.deepEqual(rels, ["🚀 Personal/🩷 Friends & Family/Noa.md"]);
    assert.equal(out[0].mtimeDate, "2026-06-15");

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("cost estimation", () => {
  it("estimates tokens from char length", () => {
    assert.equal(estimateTokens("1234"), 1);
    assert.equal(estimateTokens("12345678"), 2);
  });

  it("returns positive USD cost", () => {
    const c = estimateCostUsd(1000, 500, "gpt-5.6-luna");
    assert.ok(c > 0);
  });
});
