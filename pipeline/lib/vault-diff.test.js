import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  computeVaultDiff,
  buildNextVaultFiles,
  normalizePathKey,
  normalizePathKeyedMap,
  walkMarkdownFiles
} from "./vault-diff.js";

test("normalizePathKey collapses NFD to NFC", () => {
  const nfc = "cañon.md";
  const nfd = "can\u0303on.md";
  assert.equal(normalizePathKey(nfd), nfc.normalize("NFC"));
  assert.equal(normalizePathKey(nfd), normalizePathKey(nfc));
});

test("normalizePathKeyedMap re-keys NFD entries under NFC", () => {
  const nfd = "dir/can\u0303on.md";
  const nfc = normalizePathKey(nfd);
  const mapped = normalizePathKeyedMap({ [nfd]: { hash: "abc" } });
  assert.ok(mapped[nfc]);
  assert.equal(mapped[nfc].hash, "abc");
  assert.equal(Object.keys(mapped).length, 1);
});

test("buildNextVaultFiles drops failed sources and does not checkpoint new iCloud-pending files", () => {
  const current = {
    "notes/ok.md": { hash: "aaa" },
    "notes/failed.md": { hash: "bbb" }
  };
  const prevFiles = {
    "notes/ok.md": { hash: "old-ok" },
    "notes/failed.md": { hash: "old-failed" },
    "notes/evicted.md": { hash: "old-evicted" }
  };
  const files = buildNextVaultFiles({
    current,
    prevFiles,
    failedPaths: ["notes/failed.md"],
    icloudPending: [{ path: "notes/evicted.md" }, { path: "notes/brand-new-pending.md" }]
  });
  assert.deepEqual(Object.keys(files).sort(), ["notes/evicted.md", "notes/ok.md"]);
  assert.equal(files["notes/ok.md"].hash, "aaa");
  assert.equal(files["notes/evicted.md"].hash, "old-evicted");
  assert.equal(files["notes/failed.md"], undefined);
  assert.equal(files["notes/brand-new-pending.md"], undefined);
});

test("NFD-keyed previous state vs NFC-keyed disk yields no phantom moves/deletes", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-diff-nfc-"));
  try {
    const relNfc = "notes/cañon.md";
    const full = path.join(tmp, ...relNfc.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const body = "# hello\n";
    fs.writeFileSync(full, body, "utf8");

    const walked = walkMarkdownFiles(tmp);
    assert.equal(walked.length, 1);
    assert.equal(walked[0].relPath, normalizePathKey(relNfc));

    const { current } = computeVaultDiff(tmp, {});
    const nfcKey = Object.keys(current)[0];
    assert.equal(nfcKey, normalizePathKey(relNfc));

    // Simulate a legacy state file that stored the path as NFD.
    const nfdKey = nfcKey.normalize("NFD");
    assert.notEqual(nfdKey, nfcKey);
    const prevFiles = { [nfdKey]: current[nfcKey] };

    const diff = computeVaultDiff(tmp, prevFiles);
    assert.equal(diff.moved.length, 0, `unexpected moves: ${JSON.stringify(diff.moved)}`);
    assert.equal(diff.deleted.length, 0, `unexpected deletes: ${JSON.stringify(diff.deleted)}`);
    assert.equal(diff.created.length, 0, `unexpected creates: ${JSON.stringify(diff.created)}`);
    assert.ok(diff.unchanged.includes(nfcKey) || diff.normalizedOnly.includes(nfcKey) || diff.modified.length === 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function writeVaultFile(root, rel, body) {
  const full = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, "utf8");
}

function moveVaultFile(root, from, to) {
  const dest = path.join(root, ...to.split("/"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(path.join(root, ...from.split("/")), dest);
}

test("moving a file without edits is a move; moving and editing is a new file", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-diff-move-"));
  try {
    writeVaultFile(tmp, "🗓️ Daily notes/2026.09.01.md", "# 1 sept\nreunión con Noa\n");
    writeVaultFile(tmp, "🗓️ Daily notes/2026.09.02.md", "# 2 sept\nnada\n");
    const prev = computeVaultDiff(tmp, {}).current;

    moveVaultFile(tmp, "🗓️ Daily notes/2026.09.01.md", "🗓️ Daily notes/2026/09 septiembre/2026.09.01.md");
    moveVaultFile(tmp, "🗓️ Daily notes/2026.09.02.md", "🗓️ Daily notes/2026/09 septiembre/2026.09.02.md");
    fs.appendFileSync(
      path.join(tmp, "🗓️ Daily notes", "2026", "09 septiembre", "2026.09.02.md"),
      "idea nueva\n"
    );

    const diff = computeVaultDiff(tmp, prev);
    assert.deepEqual(
      diff.moved.map((m) => [m.from, m.to]),
      [["🗓️ Daily notes/2026.09.01.md", "🗓️ Daily notes/2026/09 septiembre/2026.09.01.md"]]
    );
    assert.deepEqual(diff.created, ["🗓️ Daily notes/2026/09 septiembre/2026.09.02.md"]);
    assert.deepEqual(diff.deleted, ["🗓️ Daily notes/2026.09.02.md"]);
    assert.deepEqual(diff.modified, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("byte-identical copy is reported as a move while the original stays unchanged", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-diff-copy-"));
  try {
    writeVaultFile(tmp, "notes/a.md", "# a\ncontenido\n");
    const prev = computeVaultDiff(tmp, {}).current;
    writeVaultFile(tmp, "otros/a.md", "# a\ncontenido\n");

    const diff = computeVaultDiff(tmp, prev);
    assert.deepEqual(diff.moved.map((m) => [m.from, m.to]), [["notes/a.md", "otros/a.md"]]);
    assert.ok(diff.unchanged.includes("notes/a.md"));
    assert.deepEqual(diff.created, []);
    assert.deepEqual(diff.deleted, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
