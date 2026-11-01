# Architecture

A personal knowledge system where an agent-maintained Obsidian wiki is the source of truth, and Postgres/pgvector is a disposable index served over MCP.

The diagram in the README is the map. This page is the contract.

## Who writes what

| Layer | Writes | Does not write |
|---|---|---|
| Human | Notes under `💼 Work/`, `🚀 Personal/`, `🗓️ Daily notes/`, and files dropped in `📥 Inbox/` | Wiki pages, Postgres |
| Pipeline | `📒 Wiki/`, three state JSON files in the vault, the usage ledger | Postgres, human notes, the inbox |
| Bridge | `brain_chunks`, `doc_chunks`, module tables | The vault. It never reads it |

The bridge only sees the chunks the pipeline posts. Confirm `BRIDGE_URL` before any ingest with `--prune`.

## Vault

Folders and ownership are in `vault-template/CLAUDE.md`. Inbox is immutable. The wiki belongs to the agent. Human notes are read-only unless the user says otherwise. Resources are shared.

That same file is the system prompt of `synthesize:wiki` (`loadVaultRules` in `pipeline/synthesize-wiki.js`).

Page frontmatter: `title`, `type` (`source`, `entity`, `concept`, `synthesis`; essays are a folder, not a fifth type the index treats specially), `created`, `updated`, `sources`, `tags`, and optionally `extractive`, `source_vault`, `event_date`. `lookup` is a tag. `index.md` and `log.md` have no frontmatter and are not indexed. Nothing under `logs/` is indexed.

## Pipeline

`sync:wiki` order (`pipeline/sync-wiki-pipeline.js`): synthesize, then detect with `SYNC_WIKI=1` so the snapshot does not move, then ingest with `--prune`.

Detection (`pipeline/lib/vault-diff.js`) uses a raw hash and a normalized hash, a low-significance heuristic, and rename detection when the hash matches an old path. mtime is not the signal.

Deterministic skips: prefixes from `pipeline/lib/layout.js`, notes under 200 bytes, and daily notes that are still the empty template (`pipeline/lib/wiki-daily-skip.js`).

Synthesis steps: `analysis` (a JSON plan), then `source`, `update`, and `create`.

Guards, in order: title match; placeholder and shrink; fact retention at 0.9 to write and 0.5 as a hard checkpoint failure, with one retry that returns the lost facts; a surgical `##` splice on pages over 25,000 characters.

Maintenance without an LLM: `index.md` is rebuilt from frontmatter, dated status snapshots move into monthly chronologies, and 1:1 entries older than three months move to quarterly archives. A single `⚠ wiki-sync.md` in the inbox tracks hard failures and is deleted when nothing is pending.

State files, inside the vault: `.canonical-wiki-vault-state.json`, `.canonical-wiki-brain-ingest-state.json`, `.canonical-wiki-wiki-alerts.json`.

## Index

Chunking (`pipeline/lib/brain-wiki.js`): `##` sections and the preamble. A section up to 2,500 characters is one chunk. Longer sections split into 800-character pieces with an overlap of 50. Embeddings are `text-embedding-3-large` at 1536 dimensions, HNSW cosine. `brain_chunks` is separate from `doc_chunks`. `document_date` is page freshness. `event_date` is when the fact happened. Legacy filters use `COALESCE`. Tables are created at boot with `CREATE TABLE IF NOT EXISTS` and `ALTER … ADD COLUMN IF NOT EXISTS`. There is no migrations folder.

## Bridge

A module is `mountXRoutes`, `mountXMcp`, and optionally `initXSchema`. `bridge/server.js` checks the key length, then imports `bridge/app.js`, which mounts only `ENABLED_MODULES`. The default is `brain`.

## MCP transport

Streamable HTTP, no session. `POST` creates a server and discards it. `GET` and `DELETE` return 405. CORS is open. No cookies.

Initialize smoke, after `npm start`:

```bash
curl -s -X POST http://127.0.0.1:3000/brain \
  -H "Authorization: Bearer $BRIDGE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
```

A 200 with a server name in the body means the endpoint is up. With `ENABLED_MODULES=brain`, `POST /ynab` is 404.

## Endpoint contracts

Scope `write` is the master key or an OAuth access token. Scope `read` is `BRIDGE_READ_KEY`. Non-GET routes under `/v1` require write. MCP write tools are not registered for a read credential.

### `/brain`

Read tools: `search_brain` (query, optional `page_type`, `tag`, event or document dates, limit 10), `list_brain_pages`, `get_brain_page` (filename), `find_related` (limit 8).

REST write: `POST /v1/brain/ingest`, `DELETE /v1/brain/documents`. REST read: `GET /v1/brain/search`, `GET /v1/brain/documents`, `GET /v1/brain/documents/:source`.

### `/ynab` (optional)

About twenty read tools, seven write tools (`create_transaction`, `update_transaction`, `update_transactions`, `create_scheduled_transaction`, `update_scheduled_transaction`, `delete_scheduled_transaction`, `update_category_budget`), and about fifteen analytics tools including `get_savings_rate`. REST mirrors them under `/v1`. Savings groups are not hardcoded: `YNAB_SAVINGS_EXCLUDE_GROUPS` and `YNAB_EARMARKED_GROUPS`.

### `/withings` (optional)

Ten read tools. REST: auth URL, status, body measurements, activity, workouts, sleep summary. Public `GET /withings/callback` returns a fixed sentence, not the exception text.

### `/bills` (optional)

Eight read tools, from `search_bills` through `compare_bills`. REST ingest and delete are write; search and documents are read. Rows use the `factura_` prefix.

### `/job` (optional)

`search_documents`, `list_documents`, `get_document_content`. REST matches bills. Queries exclude `factura_%`.

## Auth

Public routes: `/`, `/health`, `/authorize`, `/token`, `/withings/callback`.

`BRIDGE_API_KEY`, and `BRIDGE_READ_KEY` and `OAUTH_CLIENT_SECRET` when set, must be at least 32 bytes or the process exits before it listens. Comparison is `crypto.timingSafeEqual` on SHA-256 digests. Ten auth failures per IP in fifteen minutes: the eleventh response is 429. Authenticated traffic is capped at 120 requests per minute per credential, in memory. `TRUST_PROXY=1` trusts `X-Forwarded-For`. Without it, that header is ignored.

`/token` returns a random access token. It never returns the master key. Redirect URIs are an exact list. An empty `OAUTH_REDIRECT_URIS` makes `/authorize` return 400.

Expected errors are `PublicError` and keep their message (`Document not found`, `OPENAI_API_KEY not configured`). Anything else is `{ "error": "internal_error" | "upstream_error", "id": "…" }` and the real error is logged.

## Failure signatures

- `401` and body `Unauthorized`: the key, token, or read/write scope is wrong. After ten failures from the same IP the next response is `429`.
- `500` with `not configured` or a named missing variable: that module's credential or `DATABASE_URL` / `OPENAI_API_KEY` is unset. A missing document is `404` and `Document not found`, which is not the same case.
- `413`: the ingest body is over the 2mb JSON limit.
- Nested wiki folders or a missing `OBSIDIAN_VAULT_PATH`: the pipeline exits non-zero and names the variable. It does not fall back to a default vault.

## Configuration

`PATH` and `HOME` are inherited by child processes (the Claude CLI, the boot smoke). They are not settings.

Every other `process.env` name the code reads:

| Name | Required | Default |
|---|---|---|
| `ACCESS_TOKEN_TTL_MS` | no | 1 hour |
| `AUDIT_FIDELITY_INBOX` | no | off; `1` writes a note into the inbox |
| `BILLS_DOCS_PATH` | when ingesting bills | none; the script exits |
| `BILLS_USE_STORED_EXTRACT` | no | on; `0` forces the LLM; `strict` never calls it |
| `BRAIN_INGEST_BATCH_SIZE` | no | 20 |
| `BRAIN_INGEST_STATE_FILE` | no | vault root, `.canonical-wiki-brain-ingest-state.json` |
| `BRAIN_MAX_CHUNKS_PER_PAGE` | no | 25, warning only |
| `BRAIN_WIKI_DIR_NAME` | no | `📒 Wiki` |
| `BRIDGE_API_KEY` | yes, to boot | none; at least 32 bytes |
| `BRIDGE_READ_KEY` | no | unset means no read-only credential |
| `BRIDGE_URL` | for pipeline calls | `http://localhost:3000` |
| `CLAUDE_BIN` | no | `claude` on `PATH`, or `~/.local/bin/claude` if that file exists |
| `CLAUDE_MODEL` | no | the CLI default |
| `CLAUDE_TIMEOUT_MS` | no | 15 minutes |
| `DAILY_NOTES_DIR` | no | `🗓️ Daily notes` |
| `DATABASE_SSL` | no | off; `true` enables TLS with `rejectUnauthorized: false` |
| `DATABASE_URL` | yes, to serve the index | compose: `postgresql://brain:brain@127.0.0.1:5432/brain` |
| `DEEPSEEK_ALLOW_PEAK` | no | unset refuses DeepSeek peak hours |
| `DEEPSEEK_API_KEY` | when synthesis uses DeepSeek | none |
| `ENABLED_MODULES` | no | `brain` |
| `INBOX_DIR` | no | `📥 Inbox` |
| `JOB_DOCS_PATH` | when ingesting job PDFs | none; the script exits |
| `LLM_USAGE_LOG` | no | `.llm-usage.jsonl` in the working directory |
| `MONTHLY_ANCHOR_DOCS` | no | empty |
| `MONTHLY_BUDGET_ID` | for the monthly report's budget section | empty |
| `MONTHLY_HTTP_TIMEOUT_MS` | no | 60000 |
| `MONTHLY_INPUT_COST_PER_MILLION` | no | rate table |
| `MONTHLY_JSON_REPAIR` | no | on; `off` disables it |
| `MONTHLY_LLM_PROVIDER` | no | `openai`; `claude` uses the CLI |
| `MONTHLY_MAX_CONTEXT_CHARS` | no | 900000, or 450000 with Claude |
| `MONTHLY_MAX_DOC_CHARS` | no | 60000 |
| `MONTHLY_MAX_TOUCHED_DOCS` | no | 50 |
| `MONTHLY_MAX_TOUCHED_DOCS_CHARS` | no | 400000 |
| `MONTHLY_NEWSAPI_CONCEPTS` | no | `{}` |
| `MONTHLY_NEWSAPI_EVENTS_PER_ASSET` | no | 5 |
| `MONTHLY_NEWSAPI_LANG` | no | `eng` |
| `MONTHLY_OUTPUT_COST_PER_MILLION` | no | rate table |
| `MONTHLY_PORTFOLIO_DOC` | no | empty |
| `MONTHLY_PROMPT_CACHE` | no | `implicit` |
| `MONTHLY_REVIEW_DOC` | no | empty; the section is skipped |
| `MONTHLY_SYNTHESIS_API_KEY` | no | falls back to `OPENAI_API_KEY` or `DEEPSEEK_API_KEY` |
| `MONTHLY_SYNTHESIS_BASE_URL` | no | provider default |
| `MONTHLY_SYNTHESIS_MODEL` | no | `gpt-5.6-luna` |
| `MONTHLY_SYNTHESIS_TEMPERATURE` | no | provider default |
| `MONTHLY_TOUCHED_DIRS` | no | `🚀 Personal,💼 Work` |
| `MONTHLY_TR_ACCOUNT_ID` | no | empty |
| `MONTHLY_WEBSEARCH_MAX_OUTPUT_TOKENS` | no | 20000 |
| `MONTHLY_WEBSEARCH_MODEL` | no | `gpt-5.6-luna` |
| `NEWSAPI_BASE_URL` | no | the client's default |
| `NEWSAPI_KEY` | for monthly news | none |
| `OAUTH_CLIENT_ID` | no | `canonical-wiki` |
| `OAUTH_CLIENT_SECRET` | to use `/token` | none; at least 32 bytes if set |
| `OAUTH_REDIRECT_URIS` | to use `/authorize` | empty, and then `/authorize` is 400 |
| `OBSIDIAN_VAULT_PATH` | for every pipeline script that reads a vault | none; the script exits |
| `OPENAI_API_KEY` | to embed or to call OpenAI | none |
| `OPENAI_CHAT_MODEL` | no | `gpt-4o-mini` |
| `OPENAI_EMBEDDING_DIMENSIONS` | no | 1536 |
| `OPENAI_EMBEDDING_MODEL` | no | `text-embedding-3-large` |
| `PORT` | no | 3000 |
| `PREP121_ALLOWED_TOOLS` | no | `Read,Grep,Glob,mcp__linear,mcp__claude_ai_Linear` |
| `REEMBED_BATCH_SIZE` | no | 25 |
| `REEMBED_SLEEP_MS` | no | 150 |
| `REFRESH_TOKEN_TTL_MS` | no | 30 days |
| `STRIP_BINARY_BLOBS` | no | on; `off` keeps data URIs |
| `SYNC_WIKI` | set by `sync:wiki` | unset |
| `TRUST_PROXY` | no | off; `1` trusts `X-Forwarded-For` |
| `VAULT_STATE_FILE` | no | vault root, `.canonical-wiki-vault-state.json` |
| `WIKI_ALERTS_STATE_FILE` | no | vault root, `.canonical-wiki-wiki-alerts.json` |
| `WIKI_ALERT_FACT_RETENTION` | no | 0.5 |
| `WIKI_AUDIT_MIN_BODY_CHARS` | no | the script's built-in |
| `WIKI_BACKUP_DIR` | no | no backups |
| `WIKI_CONTEXT_MAX_CHARS` | no | 80000 |
| `WIKI_EXCLUDE_PREFIXES` | no | wiki, Resources. Inbox is synthesized. `⚠ wiki-sync.md` is not |
| `WIKI_EXISTING_PAGE_MAX_CHARS` | no | 100000 |
| `WIKI_EXTRACTIVE_EXCLUDE` | no | empty |
| `WIKI_EXTRACTIVE_MIN_CHARS` | no | classifier default |
| `WIKI_EXTRACTIVE_MIN_DATED_HEADINGS` | no | classifier default |
| `WIKI_EXTRACTIVE_MIN_EXISTING_RETENTION` | no | 0.85 |
| `WIKI_EXTRACTIVE_MIN_FACTS` | no | classifier default |
| `WIKI_EXTRACTIVE_MIN_TABLE_PCT` | no | classifier default |
| `WIKI_EXTRACTIVE_PATHS` | no | empty |
| `WIKI_INCLUDE_PREFIXES` | no | empty |
| `WIKI_INDEX_MODE` | no | `compact` |
| `WIKI_JSON_REPAIR` | no | on; `off` disables it |
| `WIKI_LLM_MAX_TOKENS` | no | 32768 |
| `WIKI_LLM_RETRIES` | no | 2 |
| `WIKI_LLM_RETRY_DELAY_MS` | no | 1500 |
| `WIKI_LLM_SDK_RETRIES` | no | 3 |
| `WIKI_LLM_STREAM` | no | on; `off` disables streaming |
| `WIKI_LLM_TIMEOUT_MS` | no | 900000 |
| `WIKI_MIN_FACT_RETENTION` | no | 0.9 |
| `WIKI_PAGE_SPLIT_WARN_CHARS` | no | 25000 |
| `WIKI_PROMPT_LAYOUT` | no | current; `legacy` is the old layout |
| `WIKI_PROMPT_LAYOUT_STEPS` | no | `source,create` |
| `WIKI_SOURCE_MAX_CHARS` | no | 100000 |
| `WIKI_SURGICAL_SECTION_MAX_CHARS` | no | 12000 |
| `WIKI_SYNTHESIS_API_KEY` | no | falls back to the provider key |
| `WIKI_SYNTHESIS_BASE_URL` | no | provider default |
| `WIKI_SYNTHESIS_MODEL` | no | `gpt-5.6-luna` |
| `WIKI_THINKING_EFFORT` | no | unset |
| `WIKI_THINKING_STEPS` | no | `analysis` |
| `WIKI_TREE_INCLUDE_WIKI` | no | off; `1` includes the wiki in the tree sent to the model |
| `WIKI_UPDATE_MIN_BODY_RATIO` | no | guard default |
| `WITHINGS_CLIENT_ID` | for Withings | none |
| `WITHINGS_CLIENT_SECRET` | for Withings | none |
| `WITHINGS_REDIRECT_URI` | for Withings | none |
| `WITHINGS_SCOPE` | no | `metrics,activity` |
| `YNAB_API_TOKEN` | for YNAB | none |
| `YNAB_EARMARKED_GROUPS` | no | empty |
| `YNAB_SAVINGS_EXCLUDE_GROUPS` | no | empty |
| `YNAB_SAVINGS_MIN_INCOME` | no | 500 |
