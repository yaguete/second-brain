import { mountMcpEndpoint } from "../../shared/mcp.js";
import { registerCallback, registerV1Routes } from "./routes.js";
import { registerWithingsDataRoutes } from "./data-routes.js";
import { createWithingsMcpServer } from "./mcp.js";
export { initWithingsSchema } from "./schema.js";

export function mountWithingsCallback(app) {
  registerCallback(app);
}

export function mountWithingsV1Routes(app) {
  registerV1Routes(app);
  registerWithingsDataRoutes(app);
}

export function mountWithingsMcp(app) {
  mountMcpEndpoint(app, "/withings", (auth) => createWithingsMcpServer(auth));
}
