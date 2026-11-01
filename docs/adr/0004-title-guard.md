# Validate title before writing a page

## Context

The model sometimes returned one person's page body for another person's file. A later ingest then indexed the crossed content under the wrong name.

## Decision

If the frontmatter `title` does not match the title expected for the target file, the page is not written and the source is a hard failure.

## Consequences

A cross-write never lands. That source has to be retried. The checkpoint does not advance past a hard failure.

Code: `pipeline/lib/wiki-update-guard.js`, `pipeline/synthesize-wiki.js`.
