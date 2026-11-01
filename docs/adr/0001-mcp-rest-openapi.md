# MCP, REST, and OpenAPI side by side

## Context

Ingest scripts, the monthly report, and Custom GPT Actions need plain HTTP. Chat clients speak MCP. Keeping a single surface would force an adapter on one of those clients.

## Decision

The same module services are exposed as REST under `/v1`, as stateless MCP, and as OpenAPI documents in `bridge/openapi/`. `bridge/server.js` only mounts what `ENABLED_MODULES` lists.

## Consequences

Three contracts have to stay aligned: a tool, its REST route, and the YAML. Any client works without an adapter. A new connector is a folder with `mountXRoutes`, `mountXMcp`, and an optional `initXSchema`.

Code: `bridge/server.js`, `bridge/app.js`, `bridge/openapi/`.
