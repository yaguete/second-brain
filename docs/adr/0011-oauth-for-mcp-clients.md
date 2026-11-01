# A minimal OAuth issuer for MCP clients, separate from Withings

## Context

Remote connectors expect an authorization-code grant, not a header the user pastes into every client. Withings has its own OAuth with the vendor. Those two flows are not the same secret.

## Decision

`/authorize` and `/token` issue an in-memory access token (default 1 hour) and a rotating refresh token (30 days). The client secret is `OAUTH_CLIENT_SECRET`, not the API key. Redirect URIs are an exact allowlist; an empty list makes `/authorize` return 400. The master key still works as `X-API-Key` or `Bearer`. Withings keeps `GET /withings/callback`.

## Consequences

There is a small issuer to maintain. A restart drops issued tokens. The API key keeps working. PKCE and `.well-known` are not implemented.

Code: `bridge/src/oauth-bridge.js`, `bridge/src/shared/tokens.js`, `bridge/src/shared/secrets.js`.
