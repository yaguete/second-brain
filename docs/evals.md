# Evals

Two checks. `audit:fidelity` is deterministic and compares hard facts in a wiki page with the note named by `source_vault`. `eval:wiki` is an A/B of `synthesize:wiki` on a copy of the vault. It calls a model and restores the wiki afterwards. Run it only on a copy.

## audit:fidelity on the demo

Command, against a copy of `examples/demo-vault`, with the minimum lowered so the short demo pages qualify:

```bash
OBSIDIAN_VAULT_PATH=<copy> node pipeline/audit-fidelity.js --min-facts=1
```

Result of the run on the wiki `sync:wiki` produced, 1 November 2026:

- Auditable pages: 16
- Mean retention: 94.1%
- Minimum: 50.0%

Thirteen pages kept every fact. The three misses:

| Retention | Lost | Page | Fact |
| --- | ---: | --- | --- |
| 50.0% | 1/2 | `sources/source-notas-de-lectura-octubre-2026.md` | `18.10.2026` |
| 75.0% | 1/4 | `sources/source-sam-okafor.md` | `2026-10-14` |
| 80.0% | 1/5 | `sources/source-noa-lindqvist.md` | `2026-10-20` |

The write guard, at the default 0.9, would have retried the 75% and 80% pages. The 50% page has only two hard facts, below the guard's usual minimum, so it was saved. Both extractive pages (`source-puerto-alto`, `source-posicion-zzzt`) scored 100%.

## eval:wiki

Run on a copy, re-synthesising the Noa Lindqvist 1:1 of 29 October 2026. Each arm restores the wiki when it finishes. Retention is scored only on entity, concept, and synthesis pages that actually changed and that had at least three hard facts.

```bash
npm run eval:wiki -- --file "💼 Work/People/1-1s/Noa Lindqvist/2026-10-29 1-1 Noa Lindqvist.md" \
  --a "WIKI_SYNTHESIS_MODEL=gpt-5.6-luna" \
  --b "WIKI_SYNTHESIS_MODEL=gpt-4o-mini"
```

| Arm | Model | Pages scored | Mean | Min | List price |
| --- | --- | ---: | ---: | ---: | ---: |
| A | gpt-5.6-luna | 3 | 100% | 100% | $0.0103 |
| B | gpt-4o-mini | 2 | 100% | 100% | $0.0046 |

Arm A rewrote `entity-harbor-permits`, `entity-noa-lindqvist-1-1s`, and `entity-pa-2026-184`. Arm B rewrote the last two and left Harbor Permits untouched. On the pages each arm did rewrite, no hard fact was lost. Do not commit the snapshot.
