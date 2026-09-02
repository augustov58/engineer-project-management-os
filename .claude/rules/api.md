---
paths:
  - "apps/api/**"
---
# Rules for `apps/api`

Ground rules moved out of `AGENTS.md` on 2026-09-01, none rewritten. Claude Code loads this file when a
path in the frontmatter is read through the Read tool; from the shell, read it yourself. The rules that
apply to every path stay in `AGENTS.md`.

- Never call `new Date()` or `Date.now()` for a timestamp that gets persisted or aged, and never give such a column a database default — read the injected `TimeSource` (ADR-0022). Aging is tested by advancing a fake, never by sleeping.
- Tests drive the HTTP API against a real PostgreSQL and assert only on responses and subsequent reads. Build fixtures through the API, not by inserting rows.
- The one sanctioned exception is a schema invariant no route can expose — "no `users` table exists" (ADR-0012). `apps/api/test/schema.test.ts` reads `information_schema` through the harness's `tableNames()` and nothing else; it may not read domain data or write rows.
- Every route sits under `/v1` (ADR-0023), carried by the single `register` call in `apps/api/src/server.ts` rather than spelled into each path. That call is *one* call on purpose: the thirteen route modules it invokes are plain functions and not Fastify plugins, because a plugin would be a second place a prefix could be added and the ADR's guarantee would become a convention (ADR-0033).
- A record type is a file under `apps/api/src/routes/`, named for the record and matching the test file that drives it (ADR-0033). Its schemas, its refusals that nothing else uses and its derive-on-read helpers live beside its routes. `server.ts` is the boundary and nothing else: the ajv setting, the gate in front of every route (ADR-0020), the prefix, and the list of record types. The gate is there for the reason the prefix is — it applies to all of them and to nothing narrower — and its implementation is a leaf, so `server.ts` gains a call and not a mechanism.
- `http.ts`, `refusals.ts`, `wire.ts`, `stream.ts` and `edge-gate.ts` are **leaves** — they import Prisma and Fastify types and nothing from a route module, which is what stops `site-visits`, `photos` and `issues` importing each other in a cycle (ADR-0033). A thing used by exactly one record lives with that record and moves into a leaf only when a second record reaches for it: the SSE machinery was written inside `routes/voice.ts` and became `stream.ts` when a walk's reports reached for it (ADR-0035), which is exactly the trigger ADR-0033 names, and the 24 voice tests pass unchanged against it. `wire.ts` holds only the read shapes two or more records return; `withDerivedState` and `withLines` are used by one each and stayed put.
- `startTestApi({ worker: false })` **substitutes nothing** — it does not start a worker,
  which is a state production has too: the API up with a job still sitting in Redis. It is
  how *queued* became a state a test can stand in and look at, for work with no vendor seam
  to hold open the way `heldTranscriber` holds a transcription.
- No embedding, no vector column, no similarity ranking and **no full-text index**
  (ADR-0019). `schema.test.ts` asserts no `embeddings`, `document_embeddings` or
  `search_index` table, which is as far as ADR-0012's sanctioned exception reaches; a
  `tsvector` column would need that exception widened, and it deliberately is not.
