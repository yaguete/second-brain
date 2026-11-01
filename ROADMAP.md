# ROADMAP

Only things this code does not do.

- PKCE on `/authorize`, and a `.well-known` OAuth metadata document. Clients that need dynamic discovery are configured with the API key by hand.
- Encrypt Withings tokens at rest. `withings_oauth` stores them in plaintext.
- A token store that survives a process restart. Access tokens, refresh tokens, and auth-code grants are in memory.
- Postgres TLS with certificate verification. `DATABASE_SSL=true` uses TLS with `rejectUnauthorized: false`.
- A local embedding model. Embeddings are OpenAI `text-embedding-3-large` at 1536 dimensions, one chunk at a time.
- More than one user. One Withings row, one wiki writer, no queue.
- An interactive Node wizard. `/init-brain` is an agent skill.
- English headings for the daily note and the 1:1 parsers. The pipeline is Spanish-first.
- ASCII folder names as a supported default. Emoji folders are the template. Overrides exist as env vars and are not a second layout.
