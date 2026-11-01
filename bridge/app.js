import express from "express";
import { ENABLED_MODULES, TRUST_PROXY } from "./src/config.js";
import { requireApiKey, requireWrite } from "./src/middleware/auth.js";
import { mountOAuthBridge } from "./src/oauth-bridge.js";
import { mountYnabRoutes, mountYnabMcp } from "./src/modules/ynab/index.js";
import { mountJobRoutes, mountJobMcp, initJobSchema } from "./src/modules/job/index.js";
import { mountBillsRoutes, mountBillsMcp, initBillsSchema } from "./src/modules/bills/index.js";
import { mountBrainRoutes, mountBrainMcp, initBrainSchema } from "./src/modules/brain/index.js";
import {
  mountWithingsCallback,
  mountWithingsV1Routes,
  mountWithingsMcp,
  initWithingsSchema
} from "./src/modules/withings/index.js";

export function enabledModules() {
  return new Set(ENABLED_MODULES);
}

export function createApp() {
  const app = express();
  if (TRUST_PROXY) app.set("trust proxy", 1);
  app.use(express.json({ limit: "2mb" }));

  app.get("/", (_req, res) => res.json({ service: "canonical-wiki", ok: true }));
  app.get("/health", (_req, res) => res.json({ ok: true }));

  mountOAuthBridge(app);

  const enabled = enabledModules();
  if (enabled.has("withings")) mountWithingsCallback(app);

  app.use("/v1", requireApiKey);
  app.use("/v1", (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    return requireWrite(req, res, next);
  });

  if (enabled.has("withings")) mountWithingsV1Routes(app);
  if (enabled.has("ynab")) mountYnabRoutes(app);
  if (enabled.has("job")) mountJobRoutes(app);
  if (enabled.has("bills")) mountBillsRoutes(app);
  if (enabled.has("brain")) mountBrainRoutes(app);

  if (enabled.has("ynab")) mountYnabMcp(app);
  if (enabled.has("job")) mountJobMcp(app);
  if (enabled.has("bills")) mountBillsMcp(app);
  if (enabled.has("withings")) mountWithingsMcp(app);
  if (enabled.has("brain")) mountBrainMcp(app);

  return app;
}

export function initSchemas() {
  const enabled = enabledModules();
  const jobs = [];
  if (enabled.has("job")) jobs.push(initJobSchema());
  if (enabled.has("withings")) jobs.push(initWithingsSchema());
  if (enabled.has("brain")) jobs.push(initBrainSchema());
  if (enabled.has("bills")) jobs.push(initBillsSchema());
  return Promise.all(jobs);
}
