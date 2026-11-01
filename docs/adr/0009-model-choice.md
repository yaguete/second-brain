# Pick the chat model by cost, keep embeddings fixed

## Context

Synthesis is the expensive step and the one most likely to change provider. Embeddings are the index.

## Decision

The chat model is `WIKI_SYNTHESIS_MODEL`, default `gpt-5.6-luna`, with an optional base URL for a DeepSeek-compatible endpoint. Embeddings stay `text-embedding-3-large` at 1536 dimensions. Bill extraction uses `gpt-4o-mini`. List rates live in `bridge/src/shared/llm-usage.js`, and every call can be appended to a local ledger.

## Consequences

Changing the synthesis model is a config edit. Changing the embedding model requires `reembed:*`. The ledger is gitignored.

Code: `bridge/src/shared/llm-usage.js`, `bridge/src/shared/openai.js`, `pipeline/synthesize-wiki.js`.
