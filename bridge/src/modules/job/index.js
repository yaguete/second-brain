import { mountMcpEndpoint } from "../../shared/mcp.js";
import { register as registerJobRoutes } from "./routes.js";
import { createJobMcpServer } from "./mcp.js";
export { initJobSchema } from "./schema.js";

export function mountJobRoutes(app) {
  registerJobRoutes(app);
}

export function mountJobMcp(app) {
  mountMcpEndpoint(app, "/job", (auth) => createJobMcpServer(auth));
}
