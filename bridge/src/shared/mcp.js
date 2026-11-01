import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireApiKey } from "../middleware/auth.js";
import { sendError } from "./utils.js";

export function mountMcpEndpoint(app, path, serverFactory) {
  app.options(path, (_req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, X-API-Key, Authorization, Mcp-Session-Id");
    res.status(204).end();
  });

  app.use(path, (req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Expose-Headers", "Mcp-Session-Id");
    return requireApiKey(req, res, next);
  });

  app.post(path, async (req, res) => {
    try {
      const server = serverFactory(req.auth);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get(path, (_req, res) => {
    res.status(405).json({ error: "SSE not supported in stateless mode" });
  });

  app.delete(path, (_req, res) => {
    res.status(405).json({ error: "Session management not supported in stateless mode" });
  });
}
