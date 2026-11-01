# Pipeline state lives in the vault

## Context

State files in the git repo were left behind when the vault moved to another machine, and they contained real paths.

## Decision

Three JSON files sit at the vault root and travel with the notes: `.canonical-wiki-vault-state.json`, `.canonical-wiki-brain-ingest-state.json`, and `.canonical-wiki-wiki-alerts.json`. Paths can be overridden with `VAULT_STATE_FILE`, `BRAIN_INGEST_STATE_FILE`, and `WIKI_ALERTS_STATE_FILE`. There is no legacy repo-root fallback.

## Consequences

The checkpoint moves with the vault. Obsidian should hide those dotfiles. They are gitignored if they ever appear in this repo.

Code: `pipeline/lib/vault-bridge-state.js`.
