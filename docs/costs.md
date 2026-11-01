# Costs

List prices are the ones in `bridge/src/shared/llm-usage.js` (`RATES`, USD per 1M tokens). They are not a personal bill.

| Model | Cache miss in | Cache hit in | Output |
| --- | ---: | ---: | ---: |
| gpt-5.6-luna (synthesis default) | 0.20 | 0.02 | 1.20 |
| gpt-4o-mini (bills extraction and OCR) | 0.15 | 0.075 | 0.60 |
| text-embedding-3-large | billed by the provider per embedding call | | |

`gpt-5.6-luna` also has a cache-write rate of 0.25 in that table. DeepSeek rows are in the same file. A DeepSeek peak hour bills twice the off-peak rate; the code warns and refuses the peak unless `DEEPSEEK_ALLOW_PEAK=1`.

Measured on a copy of `examples/demo-vault`, 1 November 2026. `sync:wiki` synthesised 15 notes with `gpt-5.6-luna` and then embedded the wiki. `usage:report` on that synthesis ledger:

| | calls | prompt tokens | cached | output | list price |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full demo synthesis | 47 | 218,354 | 57.7% | 34,904 | $0.0675 |

`embed()` does not write the ledger, so the 84 inserted chunks are not in that dollar figure. The A/B in `docs/evals.md` is extra: $0.0103 for `gpt-5.6-luna` and $0.0046 for `gpt-4o-mini`, on one 1:1 note.

After a later run on a **copy** of `examples/demo-vault`:

```bash
npm run usage:report
```

That command reads `LLM_USAGE_LOG` (default `.llm-usage.jsonl`) and prints tokens and list-price USD for that run only. Embeddings are a separate OpenAI call per chunk and show up only if the bridge records them. The demo wiki is about sixteen pages, so the embedding pass is the small one. The synthesis pass is the one that moves the total.

Do not paste a usage log from any other vault into this file.
