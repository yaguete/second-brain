import { mountMcpEndpoint } from "../../shared/mcp.js";
import { registerYnabRoutes } from "./routes/index.js";
import { createYnabMcpServer } from "./mcp/index.js";

export function mountYnabRoutes(app) {
  registerYnabRoutes(app);
}

export function mountYnabMcp(app) {
  mountMcpEndpoint(app, "/ynab", (auth) => createYnabMcpServer(auth));
}
