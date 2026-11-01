import { mountMcpEndpoint } from "../../shared/mcp.js";
import { register } from "./routes.js";
import { createBrainMcpServer } from "./mcp.js";

export { initBrainSchema } from "./schema.js";

export function mountBrainRoutes(app) {
  register(app);
}

export function mountBrainMcp(app) {
  mountMcpEndpoint(app, "/brain", (auth) => createBrainMcpServer(auth));
}
