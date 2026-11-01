# Thinking only on the analysis step

## Context

With thinking left on, a full-page rewrite of 60,000 characters or more passed 40,000 tokens. The connection, without streaming, died with `TypeError: terminated` and the source was lost. A truncated completion could also be written as if it were the page.

## Decision

Thinking is limited to `WIKI_THINKING_STEPS` (default `analysis`). Streaming is on unless `WIKI_LLM_STREAM=off`. `max_tokens` is explicit (32,768). The SDK retries 3 times and the script retries 2. `finish_reason: length` is an error, not a page.

## Consequences

A long sync no longer dies on a silent socket close. A truncated answer is never saved as valid wiki.

Code: `pipeline/synthesize-wiki.js`.
