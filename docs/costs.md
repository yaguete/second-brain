# Costs

List prices are the ones in `bridge/src/shared/llm-usage.js` (`RATES`, USD per 1M tokens). They are not a personal bill.

| Model | Cache miss in | Cache hit in | Output |
| --- | ---: | ---: | ---: |
| gpt-5.6-luna (synthesis default) | 0.20 | 0.02 | 1.20 |
| gpt-4o-mini (bills extraction and OCR) | 0.15 | 0.075 | 0.60 |
| text-embedding-3-large | billed by the provider per embedding call | | |

`gpt-5.6-luna` also has a cache-write rate of 0.25 in that table. DeepSeek rows are in the same file. A DeepSeek peak hour bills twice the off-peak rate; the code warns and refuses the peak unless `DEEPSEEK_ALLOW_PEAK=1`.

This checkout did not run `synthesize:wiki` or `ingest:brain` against the demo. No non-production provider key was available, and the private environment file was not read. There is therefore no `.llm-usage.jsonl` and no measured cent total.

After a real run on a **copy** of `examples/demo-vault`:

```bash
npm run usage:report
```

That command reads `LLM_USAGE_LOG` (default `.llm-usage.jsonl`) and prints tokens and list-price USD for that run only. Embeddings are a separate OpenAI call per chunk and show up only if the bridge records them. The demo wiki is about sixteen pages, so the embedding pass is the small one. The synthesis pass is the one that moves the total.

Do not paste a usage log from any other vault into this file.
