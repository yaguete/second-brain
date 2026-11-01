# Stateless MCP

## Context

The process is not guaranteed a sticky session. A long-lived SSE stream would break on restart and on a second instance.

## Decision

Each `POST` builds a server, handles one JSON-RPC message, and discards it. `GET` and `DELETE` return 405. CORS is open. There are no cookies.

## Consequences

No server-sent events and no push notifications. Restarts lose nothing that mattered, because nothing was stored on the connection.

Code: `bridge/src/shared/mcp.js`.
