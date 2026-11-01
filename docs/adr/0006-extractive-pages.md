# Extractive pages, and lookup as a tag

## Context

Summarising logs, inventories, and position tables destroys the values people later look up.

## Decision

Fact-dense notes become source pages with `extractive: true`. Tables and dated entries are copied verbatim. Lookup entities stay `type: entity` and carry the tag `lookup`. There is no new page type.

## Consequences

Those pages are longer. Numbers survive. The index still has four types.

Code: `pipeline/lib/wiki-source-classify.js`, `pipeline/lib/wiki-extractive-source.js`.
