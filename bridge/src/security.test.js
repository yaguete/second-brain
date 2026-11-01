import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { secretsEqual } from "./shared/secrets.js";

const KEY = "a".repeat(32);
const READ = "b".repeat(32);
const SECRET = "c".repeat(32);

process.env.BRIDGE_API_KEY = KEY;
process.env.BRIDGE_READ_KEY = READ;
process.env.OAUTH_CLIENT_SECRET = SECRET;
process.env.OAUTH_CLIENT_ID = "second-brain";
process.env.OAUTH_REDIRECT_URIS = "http://127.0.0.1:9/cb";
process.env.ENABLED_MODULES = "brain,ynab";
delete process.env.DATABASE_URL;

test("a 31-byte key refuses to boot", () => {
  const r = spawnSync(process.execPath, ["bridge/server.js"], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      BRIDGE_API_KEY: "x".repeat(31),
      ENABLED_MODULES: "brain"
    },
    encoding: "utf8"
  });
  assert.notEqual(r.status, 0);
  assert.match(`${r.stderr}\n${r.stdout}`, /32 bytes/);
});

test("secretsEqual does not throw when lengths differ", () => {
  assert.equal(secretsEqual("short", "a-much-longer-secret"), false);
  assert.equal(secretsEqual(KEY, KEY), true);
});

test("issued access token is not the master key and expires", async () => {
  const { issueTokenPair, lookupAccessToken, rotateRefreshToken } = await import("./shared/tokens.js");
  const issued = issueTokenPair({ scope: "write", now: 1_000, accessTtlMs: 500, refreshTtlMs: 5_000 });
  assert.notEqual(issued.access_token, KEY);
  assert.notEqual(issued.refresh_token, KEY);
  assert.ok(lookupAccessToken(issued.access_token, 1_200));
  assert.equal(lookupAccessToken(issued.access_token, 1_500), null);
  const rotated = rotateRefreshToken(issued.refresh_token, 1_200, { accessTtlMs: 500, refreshTtlMs: 5_000 });
  assert.ok(rotated);
  assert.notEqual(rotated.refresh_token, issued.refresh_token);
  assert.equal(rotateRefreshToken(issued.refresh_token, 1_200), null);
});

async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  return { server, port };
}

test("authorize rejects a redirect uri that is not on the list", async () => {
  const { createApp } = await import("../app.js");
  const { server, port } = await listen(createApp());
  try {
    const url = new URL(`http://127.0.0.1:${port}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", "second-brain");
    url.searchParams.set("redirect_uri", "http://evil.example/cb");
    const res = await fetch(url, { redirect: "manual" });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("the 11th bad key returns 429", async () => {
  const { createApp } = await import("../app.js");
  const { resetAuthState } = await import("./middleware/auth.js");
  resetAuthState();
  const { server, port } = await listen(createApp());
  try {
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/v1/brain/documents`, {
        headers: { "X-API-Key": `wrong-${i}` }
      });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
    assert.equal(statuses[10], 429);
  } finally {
    server.close();
  }
});

test("a read key cannot see write tools or delete documents", async () => {
  const { createApp } = await import("../app.js");
  const { resetAuthState } = await import("./middleware/auth.js");
  resetAuthState();
  const { server, port } = await listen(createApp());
  try {
    const listed = await fetch(`http://127.0.0.1:${port}/ynab`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-API-Key": READ
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    const raw = await listed.text();
    assert.equal(listed.status, 200, raw);
    assert.equal(raw.includes("create_transaction"), false, raw);
    const del = await fetch(`http://127.0.0.1:${port}/v1/brain/documents?source=example.md`, {
      method: "DELETE",
      headers: { "X-API-Key": READ }
    });
    assert.equal(del.status, 403);
  } finally {
    server.close();
  }
});
