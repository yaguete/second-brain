# Two fact-retention thresholds and one retry

## Context

Prose updates dropped figures and dates without any signal. The page looked finished.

## Decision

Hard facts are measured before and after an update. Below `WIKI_MIN_FACT_RETENTION` (0.9) the page is not written. Below `WIKI_ALERT_FACT_RETENTION` (0.5) the checkpoint is blocked. Before giving up, the script retries once and hands the model the facts it dropped.

## Consequences

More model calls. Silent fact loss on narrative updates stops. Extractive pages are not prose-summarised at all.

Code: `pipeline/lib/wiki-fact-retention.js`, `pipeline/lib/wiki-update-guard.js`.
