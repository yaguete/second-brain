import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  emptyAlertState,
  mergePendingAlerts,
  renderAlertMarkdown,
  pendingAlertCount,
  pendingAlertPaths,
  isLegacyAlertFilename,
  alertFilePaths,
  cleanupLegacyAlertFiles,
  syncAlertFile
} from "./wiki-alerts.js";

const DAY1 = "2026-08-05T09:00:00.000Z";
const DAY2 = "2026-08-06T09:00:00.000Z";
const DAY3 = "2026-08-07T09:00:00.000Z";

const FAILURE = {
  path: "🗓️ Daily notes/2026.08.05.md",
  error: "guard skipped: entity-grayhaven.md (fact loss: retención 12.0%)",
  pages: ["entity-grayhaven.md"]
};

describe("mergePendingAlerts", () => {
  it("inserts a new entry for a hard failure", () => {
    const state = mergePendingAlerts(emptyAlertState(), {
      processedPaths: [FAILURE.path],
      hardFailures: [FAILURE],
      now: DAY1
    });
    const entry = state.alerts[FAILURE.path];
    assert.ok(entry);
    assert.equal(entry.attempts, 1);
    assert.equal(entry.first_seen, DAY1);
    assert.equal(entry.last_seen, DAY1);
    assert.deepEqual(entry.pages, ["entity-grayhaven.md"]);
    assert.deepEqual(pendingAlertPaths(state), [FAILURE.path]);
  });

  it("increments attempts and keeps first_seen on retry", () => {
    const first = mergePendingAlerts(emptyAlertState(), {
      processedPaths: [FAILURE.path],
      hardFailures: [FAILURE],
      now: DAY1
    });
    const second = mergePendingAlerts(first, {
      processedPaths: [FAILURE.path],
      hardFailures: [FAILURE],
      now: DAY2
    });
    assert.equal(second.alerts[FAILURE.path].attempts, 2);
    assert.equal(second.alerts[FAILURE.path].first_seen, DAY1);
    assert.equal(second.alerts[FAILURE.path].last_seen, DAY2);
  });

  it("removes the entry when the source is processed without hard failures", () => {
    const withAlert = mergePendingAlerts(emptyAlertState(), {
      processedPaths: [FAILURE.path],
      hardFailures: [FAILURE],
      now: DAY1
    });
    const resolved = mergePendingAlerts(withAlert, {
      processedPaths: [FAILURE.path],
      hardFailures: [],
      now: DAY2
    });
    assert.equal(pendingAlertCount(resolved), 0);
  });

  it("keeps untouched entries when a run only processes one file (--file)", () => {
    const other = { path: "💼 Work/notas.md", error: "TITLE MISMATCH", pages: ["entity-grayhaven-notes.md"] };
    const state = mergePendingAlerts(emptyAlertState(), {
      processedPaths: [FAILURE.path, other.path],
      hardFailures: [FAILURE, other],
      now: DAY1
    });
    const afterSingleFile = mergePendingAlerts(state, {
      processedPaths: [FAILURE.path],
      hardFailures: [],
      now: DAY2
    });
    assert.equal(pendingAlertCount(afterSingleFile), 1);
    assert.ok(afterSingleFile.alerts[other.path]);
    assert.equal(afterSingleFile.alerts[other.path].attempts, 1);
  });

  it("merges several hard failures of the same source into one entry", () => {
    const state = mergePendingAlerts(emptyAlertState(), {
      processedPaths: [FAILURE.path],
      hardFailures: [
        FAILURE,
        { path: FAILURE.path, error: "otro fallo", pages: ["entity-otra.md"] }
      ],
      now: DAY1
    });
    assert.equal(pendingAlertCount(state), 1);
    assert.deepEqual(state.alerts[FAILURE.path].pages, ["entity-grayhaven.md", "entity-otra.md"]);
    assert.match(state.alerts[FAILURE.path].error, /otro fallo/);
  });
});

describe("renderAlertMarkdown", () => {
  it("returns empty string for an empty state", () => {
    assert.equal(renderAlertMarkdown(emptyAlertState()), "");
  });

  it("renders a concrete action per pending source", () => {
    const state = mergePendingAlerts(emptyAlertState(), {
      processedPaths: [FAILURE.path],
      hardFailures: [FAILURE],
      now: DAY1
    });
    const md = renderAlertMarkdown(state, { now: DAY1 });
    assert.match(md, /type: wiki-sync-alert/);
    assert.match(md, /pending: 1/);
    assert.match(md, /entity-grayhaven\.md/);
    assert.match(md, /npm run synthesize:wiki -- --file "🗓️ Daily notes\/2026\.08\.05\.md"/);
    assert.match(md, /\*\*Intentos\*\*: 1/);
  });

  it("warns about stuck sources after three attempts", () => {
    let state = emptyAlertState();
    for (const now of [DAY1, DAY2, DAY3]) {
      state = mergePendingAlerts(state, {
        processedPaths: [FAILURE.path],
        hardFailures: [FAILURE],
        now
      });
    }
    const md = renderAlertMarkdown(state, { now: DAY3 });
    assert.match(md, /\*\*Intentos\*\*: 3/);
    assert.match(md, /Atascada desde 2026-08-05/);
  });
});

describe("legacy alert filenames", () => {
  it("matches only the dated scheme", () => {
    assert.equal(isLegacyAlertFilename("⚠ wiki-sync-2026-08-07.md"), true);
    assert.equal(isLegacyAlertFilename("⚠ wiki-sync.md"), false);
    assert.equal(isLegacyAlertFilename("notas-2026-08-07.md"), false);
  });
});

describe("alert files on disk", () => {
  let vaultRoot;

  beforeEach(() => {
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-alerts-"));
    fs.mkdirSync(path.join(vaultRoot, "📥 Inbox"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(vaultRoot, { recursive: true, force: true });
  });

  it("writes the canonical file and deletes it once nothing is pending", () => {
    const state = mergePendingAlerts(emptyAlertState(), {
      processedPaths: [FAILURE.path],
      hardFailures: [FAILURE],
      now: DAY1
    });
    const written = syncAlertFile(vaultRoot, state, { now: DAY1 });
    assert.equal(written.action, "written");
    assert.equal(fs.existsSync(written.path), true);
    assert.equal(path.basename(written.path), "⚠ wiki-sync.md");

    const resolved = mergePendingAlerts(state, {
      processedPaths: [FAILURE.path],
      hardFailures: [],
      now: DAY2
    });
    const removed = syncAlertFile(vaultRoot, resolved, { now: DAY2 });
    assert.equal(removed.action, "removed");
    assert.equal(fs.existsSync(written.path), false);
  });

  it("is a no-op when nothing is pending and no file exists", () => {
    assert.equal(syncAlertFile(vaultRoot, emptyAlertState()).action, "none");
  });

  it("removes legacy per-day alerts and keeps other inbox notes", () => {
    const { inboxDir } = alertFilePaths(vaultRoot);
    fs.writeFileSync(path.join(inboxDir, "⚠ wiki-sync-2026-08-06.md"), "x", "utf8");
    fs.writeFileSync(path.join(inboxDir, "⚠ wiki-sync-2026-08-07.md"), "x", "utf8");
    fs.writeFileSync(path.join(inboxDir, "monthly-2026-07-julio.md"), "x", "utf8");

    const removed = cleanupLegacyAlertFiles(inboxDir);
    assert.equal(removed.length, 2);
    assert.deepEqual(fs.readdirSync(inboxDir), ["monthly-2026-07-julio.md"]);
  });
});
