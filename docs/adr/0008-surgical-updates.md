# Surgical section updates on large pages

## Context

Rewriting a hub above 25,000 characters was expensive and dropped facts in the sections nobody meant to touch.

## Decision

Above that size the model returns a single `##` section and the script splices it in. Analysis prefers a child page over another full rewrite.

## Consequences

Fewer tokens and a smaller surface for fact loss. The splice can only be as good as the section boundary. Hubs that keep growing are split with `split:hubs` from a JSON plan, not from a hardcoded list.

Code: `pipeline/synthesize-wiki.js`, `pipeline/split-oversized-hubs.js`.
