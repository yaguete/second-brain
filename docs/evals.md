# Evals

Two checks. `audit:fidelity` is deterministic and compares hard facts in a wiki page with the note named by `source_vault`. `eval:wiki` is an A/B of `synthesize:wiki` on a copy of the vault. It calls a model and restores the wiki afterwards. Run it only on a copy.

## audit:fidelity on the demo

Command, against a copy of `examples/demo-vault`, with the minimum lowered so the short demo pages qualify:

```bash
OBSIDIAN_VAULT_PATH=<copy> node pipeline/audit-fidelity.js --min-facts=1
```

Result of that run:

- Auditable pages: 5
- Mean retention: 91.1%
- Minimum: 80.0%

| Retention | Lost | Page |
| --- | ---: | --- |
| 80.0% | 1/5 | `sources/source-1-1-noa-2026-10-29.md` |
| 85.7% | 1/7 | `sources/source-1-1-sam-2026-10-28.md` |
| 90.0% | 1/10 | `sources/source-harbor-permits.md` |
| 100% | 0/6 | `sources/source-inventario-puerto-alto.md` |
| 100% | 0/3 | `sources/source-permisos-costeros.md` |

The two misses are a lower-cased project name and one date. The extractive inventory kept every fact. The write guard, at the default 0.9, would have retried the 80% and 85.7% pages rather than saving them. These demo pages were written to match the schema so the index can be built without a model call. They are not a claim that a model produced them.

## eval:wiki

Not run. It needs a synthesis key, and none was available. The command, on a copy:

```bash
npm run eval:wiki -- --file "🗓️ Daily notes/2026.10.30.md" \
  --a "WIKI_SYNTHESIS_MODEL=gpt-5.6-luna" \
  --b "WIKI_SYNTHESIS_MODEL=gpt-4o-mini"
```

It snapshots the wiki, runs each arm, scores fact retention, and restores the snapshot. Read the script's stdout. Do not commit the snapshot.
