import { mountMcpEndpoint } from "../../shared/mcp.js";
import { register as registerBillsRoutes } from "./routes.js";
import { createBillsMcpServer } from "./mcp.js";

export { initBillsSchema } from "./schema.js";

export function mountBillsRoutes(app) {
  registerBillsRoutes(app);
}

export function mountBillsMcp(app) {
  mountMcpEndpoint(app, "/bills", (auth) => createBillsMcpServer(auth));
}
