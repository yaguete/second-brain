# The factura_ namespace on a shared doc_chunks table

## Context

Bills and job documents share an embedding pipeline and a search shape. Two tables would mean two re-embed paths for the same vectors.

## Decision

Both use `doc_chunks`. Bill rows set `document_type` to a `factura_` prefix. The job module excludes `factura_%`. Bill queries stay inside the prefix.

## Consequences

One embedding migration. Every query has to apply the prefix filter. Forgetting it mixes invoices into employment documents.

Code: `bridge/src/modules/bills/`, `bridge/src/modules/job/`.
