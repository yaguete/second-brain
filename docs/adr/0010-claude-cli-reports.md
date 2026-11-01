# Claude Code CLI for monthly and prep-121

## Context

The monthly report and the 1:1 prep need a large context or read-only tools. Putting that in the request path of the bridge would mix a long agent turn with the index server.

## Decision

`monthly` (when `MONTHLY_LLM_PROVIDER=claude`) and `prep-121` call `claude -p` with an allowlist of tools. The script writes the result. The agent does not write the vault.

## Consequences

Those commands use a local Claude session instead of the chat API, and they do nothing useful without the CLI. Timezone for `prep-121` is Europe/Madrid.

Code: `bridge/src/shared/claude-cli.js`, `pipeline/monthly.js`, `pipeline/prep-121.js`.
