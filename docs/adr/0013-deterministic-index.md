# The wiki index is rebuilt, not generated

## Context

Asking the model to update `index.md` produced `... (unchanged)` placeholders and entries for pages that did not exist.

## Decision

`index.md` is rebuilt from frontmatter. No LLM. `log.md` stays an append-only operational log and is not ingested.

## Consequences

The catalogue is idempotent and free. It cannot carry a nuance that is not in frontmatter or the title index.

Code: `pipeline/rebuild-wiki-index.js`, `pipeline/lib/brain-wiki.js`.
