import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { PublicError, sendError } from "./shared/utils.js";

process.env.BRIDGE_API_KEY = "d".repeat(32);
process.env.OPENAI_API_KEY = "dummy-local-only";
process.env.DATABASE_URL = "postgresql://brain:brain@127.0.0.1:5432/brain";
process.env.ENABLED_MODULES = "brain";
delete process.env.DATABASE_SSL;

async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, port: server.address().port };
}

test("a postgres error is internal_error with an id and no sql text", async () => {
  const app = express();
  app.get("/boom", (_req, res) => {
    const err = new Error('relation "brain_chunks" does not exist');
    err.code = "42P01";
    sendError(res, err);
  });
  const { server, port } = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/boom`);
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.equal(body.error, "internal_error");
    assert.match(body.id, /^[0-9a-f]{16}$/);
    assert.equal(JSON.stringify(body).includes("brain_chunks"), false);
  } finally {
    server.close();
  }
});

test("a missing brain document stays a descriptive 404", async () => {
  process.env.DATABASE_URL = "postgresql://brain:brain@127.0.0.1:5432/brain";
  process.env.OPENAI_API_KEY = "dummy-key-for-tests";
  process.env.BRIDGE_API_KEY = "a".repeat(32);
  process.env.ENABLED_MODULES = "brain";
  delete process.env.DATABASE_SSL;
  const { createApp, initSchemas } = await import("../app.js");
  await initSchemas();
  const app = createApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/brain/documents/inexistente`, {
      headers: { "X-API-Key": process.env.BRIDGE_API_KEY }
    });
    const body = await res.json();
    assert.equal(res.status, 404);
    assert.equal(body.error, "Document not found");
  } finally {
    server.close();
  }
});

test("PublicError keeps the descriptive message", async () => {
  const app = express();
  app.get("/missing", (_req, res) => {
    sendError(res, new PublicError(404, "not_found", "Document not found"));
  });
  const { server, port } = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/missing`);
    const body = await res.json();
    assert.equal(res.status, 404);
    assert.equal(body.error, "Document not found");
  } finally {
    server.close();
  }
});

test("GET a missing brain document stays a descriptive 404", async () => {
  const { createApp, initSchemas } = await import("../app.js");
  const { resetAuthState } = await import("./middleware/auth.js");
  resetAuthState();
  await initSchemas();
  const app = createApp();
  const { server, port } = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/brain/documents/inexistente`, {
      headers: { "X-API-Key": process.env.BRIDGE_API_KEY }
    });
    const body = await res.json();
    assert.equal(res.status, 404);
    assert.equal(body.error, "Document not found");
  } finally {
    server.close();
  }
});
