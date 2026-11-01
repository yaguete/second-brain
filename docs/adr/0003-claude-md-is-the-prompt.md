# The vault CLAUDE.md is both the schema and the system prompt

## Context

Interactive agents and the batch pipeline were going to grow two copies of the wiki rules.

## Decision

One file, `CLAUDE.md` at the vault root, documents the five operations and the page contract. `synthesize:wiki` loads it with `loadVaultRules` and uses it as the system prompt.

## Consequences

Editing the schema changes the next synthesis run. `/init-brain` fills `## Priority domains` and leaves the rest of the contract alone.

Code: `pipeline/synthesize-wiki.js` (`loadVaultRules`), `vault-template/CLAUDE.md`.
