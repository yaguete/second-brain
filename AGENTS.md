# AGENTS.md

Read this before changing the repo or a vault. The long bootstrap is `skills/init-brain/SKILL.md`. There is no Node wizard.

## What this is

An Obsidian wiki is the source of truth. Postgres with pgvector is a disposable index served over MCP and REST. Fix a wrong fact in the markdown page, then re-ingest. Do not patch `brain_chunks`.

## Operating rules

- Correct the wiki in markdown. After maintenance, `ingest:brain --prune`. Never edit a row to mirror a page.
- Human notes and `📥 Inbox/` are read-only unless the user asks otherwise.
- Do not add endpoints, tools, or modules the code does not already have. Ideas go to `ROADMAP.md`.
- Paths, MCP tool names, the stateless transport, and the `factura_` prefix are a contract. A breaking change is announced first, with a migration.
- `bridge/server.js` only composes. Logic lives in `bridge/src/modules/<name>/`.
- Unexpected HTTP and MCP errors do not return `e.message`. Use `PublicError` for errors the client should read.
- Do not commit `.env`, vault state, `.claude/`, `.cursor/`, `*.local.*`, or LLM usage logs.
- Fixtures use only the fictional set: Alex Rivera, Sam Okafor, Noa Lindqvist, Harbor Permits, Grayhaven, Tidepool, a flat in Puerto Alto, tickers ZZZT and ZZZU, emails `@example.com`.
- Do not run paid commands without an explicit yes: `sync:wiki`, `synthesize:wiki`, `eval:wiki`, `monthly`, `reembed:*`.
- `eval:wiki` and any synthesis trial run on a copy of the vault, never on the committed `examples/demo-vault`.
- Before `sync:wiki` or `ingest:brain --prune`, confirm `BRIDGE_URL` is the bridge the user means to change. Prune deletes remote chunks that are not in the local wiki.
- Never overwrite an existing skill, `CLAUDE.md`, or `.env` without showing the diff and getting a yes.
- Before calling work done: `node --check` on what you touched, `npm test`, and `npm run check:public`. If the bridge changed, also `GET /health` and the MCP initialize smoke in `docs/architecture.md`.

## Layout

`vault-template/` is the empty skeleton `/init-brain` copies. `examples/demo-vault/` is a fictional vault with notes and a wiki, for the quickstart. Point `OBSIDIAN_VAULT_PATH` at a copy. The pipeline writes into the vault.

Pipeline folder names and exclusions live in `pipeline/lib/layout.js`.
