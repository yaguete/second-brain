# The wiki is canonical and the index is regenerable

## Context

A vector index that is also the memory drifts. Summaries get re-embedded, numbers fall out, and there is nothing to diff against.

## Decision

Markdown in `📒 Wiki/` is the source of truth. `brain_chunks` is written only by `ingest:brain`. A wrong fact is fixed in the page, then the index is rebuilt. Rows are not patched by hand.

## Consequences

The database can be dropped without losing knowledge. A fact that is not in the wiki does not exist for retrieval.

Code: `pipeline/ingest-brain.js`, `bridge/src/modules/brain/schema.js`.
