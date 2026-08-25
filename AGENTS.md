# Engineer Project Management OS

Internal operations dashboard for engineering projects (schedule, budget, tasks, RFIs, submittals, documents, risks) with a Pi-powered copilot.

## Read this first

Before any work, read [CONTEXT.md](./CONTEXT.md). It points to the authoritative plan.

## Source of truth

The Obsidian vault is the single source of truth for this project's documentation, decisions, and progress:

```
/home/augusto/Obsidian Notes/Projects/Engineer Project Management OS/
```

- `PRD and Architecture.md` - product requirements, architecture, milestones, backlog.
- `docs/adr/` - architecture decision records 0001-0028; check each `Status:` line, several are superseded and one is only Proposed.
- `docs/glossary.md` - domain glossary.

Never let the vault docs drift from reality. Update them as work happens (see CONTEXT.md for the update rules).

## Current status

Slice 1 (walking skeleton and test harness, issue #2), slice 2 (the `Project` record,
issue #3), slice 3 (open items and the pending items view, issue #4), slice 4
(submissions and per-project phases, issue #5), slice 5 (provisional state and
exposure, issue #6) and slice 6 (reissue and supersede, issue #7) are built. The plan is
the six-step **Revised MVP sequence** in
`PRD and Architecture.md`, and the MVP is ticketed as GitHub
issues #2-#22. Step 1, entering T-1's own open items, needs no further code and is the
author's to do. Work one ticket at a time, and only when asked.

`pnpm dev` starts everything; `pnpm typecheck` and `pnpm test` each run from the repo root.
See [README.md](./README.md).

## Ground rules for agents

- Plan changes, scope adjustments, and vendor decisions get recorded in the vault, not only in code or commits.
- Milestone completion updates the vault progress section in the same session.
- Follow the ADRs; if an ADR must change, write a new/superseding ADR in the vault first.
- Stack: TypeScript monorepo (pnpm), Next.js frontend, Fastify API (ADR-0021), PostgreSQL + Prisma, Redis + BullMQ, S3 docs, Pi SDK via `@earendil-works/pi-coding-agent`.
- Never call `new Date()` or `Date.now()` for a timestamp that gets persisted or aged, and never give such a column a database default — read the injected `TimeSource` (ADR-0022). Aging is tested by advancing a fake, never by sleeping.
- Tests drive the HTTP API against a real PostgreSQL and assert only on responses and subsequent reads. Build fixtures through the API, not by inserting rows.
- The one sanctioned exception is a schema invariant no route can expose — "no `users` table exists" (ADR-0012). `apps/api/test/schema.test.ts` reads `information_schema` through the harness's `tableNames()` and nothing else; it may not read domain data or write rows.
- Every route sits under `/v1` (ADR-0023), carried by the single `register` call in `apps/api/src/server.ts` rather than spelled into each path.
- An open item is unresolved exactly when `resolved_at` is null (ADR-0024). Exposure, provisional state and the pending items view all read that one column — do not add a status field beside it.
- What a submission rests on is the `submission_open_items` join, never a second subject on
  the open item (ADR-0026). An open item's subject stays `PROJECT`; raising one against a
  submission attaches it and leaves it on its project. Do not add `SUBMISSION` to the
  subject enum to "simplify" this — it would have broken issues #6 and #7, and still would.
- Nothing updates a submission. There is no PATCH, no PUT and no edit route, and adding one
  is a regression against ADR-0015. A correction is `POST /v1/submissions/:id/reissue`,
  which writes a new row and nothing at all to the one it replaces (ADR-0028).
- What a set rests on is named in the same call that records it (`openItemIds`), which is
  what gives the moment of issuance something to stamp against. Attaching afterwards is the
  correction, not the entry path (ADR-0026).
- The record is a **submission**. "Issuance" is the act or the date — "issuance date", "at
  the moment of issuance" — and never the name of the record, in code or in UI copy.
- Provisional is **two** facts and neither is the other (ADR-0027). `issued_provisional` is
  stamped at the moment of issuance and never recomputed; *currently provisional* is derived
  on every read from `resolved_at` and stored nowhere. Resolving everything a set rested on
  must leave `issued_provisional` standing — that is the fact the record exists to keep.
- `submission_open_items.unresolved_at_issuance` is nullable and the null means something:
  the item was attached *after* the issuance and was no part of it. Detach is narrowed to
  exactly those rows; refusing the others is what stops cleanup erasing what went out
  (ADR-0027, settling the collision ADR-0026 recorded).
- *Superseded* is a successor existing, derived on every read and stored nowhere
  (ADR-0028) — the shape ADR-0027 gave *currently provisional*. There is no `superseded_at`
  and no flag; `submissions.supersedes_id` is unique, and that is the whole of "at most one
  successor, and the chain is linear". Do not mark the prior row: writing to it is the edit
  the record type exists to prevent.
- On a reissue, `openItemIds` **left off** carries forward what the superseded set rested
  on and **supplied** is exactly that list, so `[]` is a deliberate drop (ADR-0028). The
  successor stamps its own `unresolved_at_issuance` and `issued_provisional` at its own
  moment of issuance; the ancestor's are never rewritten.
- Exposure is a **list**, not a number (ADR-0027). `GET /v1/exposure` returns the
  submissions; every count is that list's length, so a count and the screen it links to
  cannot disagree, and there is no figure to combine into a score (ADR-0016). Archived
  projects leave the across-every-project count and keep their own, and so do superseded
  ancestors (ADR-0028) — carry-forward puts the same unresolved item on both, so counting
  the ancestor too would make the number grow by correcting the record.
- The frontend is Tailwind + shadcn/ui, components owned in `apps/web/components/ui` (ADR-0025). Where a styled component would change how a control serialises into a form, keep the native element and style it. The nobody checkbox, the pending sort select, the submission phase select and the attach-an-open-item select are all native for that reason; `apps/web/app/native-select.ts` holds the shared styling.
- `pnpm typecheck` does not compile the stylesheet and `pnpm test` does not run the frontend. Run `pnpm --filter web build` and load the pages before calling a frontend change done. Browse `http://localhost:3000`, not `127.0.0.1`: Next's dev-origin guard 403s the client chunks on the other host, so the page renders and silently never hydrates.
- A state update made from a ref callback during the **hydration** commit is discarded — the ref runs, the value is right, and the render keeps the old one. Anything a first paint must show has to be in the server's render: seed the state from props and let the ref only correct it afterwards (ADR-0028).
- `apps/web` imports carry no file extension (bundler resolution); `apps/api` imports carry `.js` (NodeNext). `tsc` accepts the wrong one and the bundler does not.

## Agent skills

### Issue tracker

GitHub Issues via the `gh` CLI, account `augustov58`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context, but the glossary and ADRs live in the Obsidian vault, not under `docs/adr/` here. See `docs/agents/domain.md`.
