import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { register as registerRead } from "./tools-read.js";
import { register as registerWrite } from "./tools-write.js";
import { register as registerAnalytics } from "./tools-analytics.js";

export function createYnabMcpServer(auth) {
  const mcp = new McpServer({ name: "ynab", version: "1.0.0" });
  registerRead(mcp);
  registerAnalytics(mcp);
  if (auth?.scope === "write") registerWrite(mcp);
  return mcp;
}
