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
- `docs/adr/` - architecture decision records 0001-0025; check each `Status:` line, several are superseded and two are only Proposed.
- `docs/glossary.md` - domain glossary.

Never let the vault docs drift from reality. Update them as work happens (see CONTEXT.md for the update rules).

## Current status

Slice 1 (walking skeleton and test harness, issue #2), slice 2 (the `Project` record,
issue #3) and slice 3 (open items and the pending items view, issue #4) are built. The
plan is the six-step **Revised MVP sequence** in `PRD and Architecture.md`, and the MVP is
ticketed as GitHub issues #2-#22. Step 1, entering T-1's own open items, needs no further
code and is the author's to do. Work one ticket at a time, and only when asked.

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
- `apps/web` imports carry no file extension (bundler resolution); `apps/api` imports carry `.js` (NodeNext). `tsc` accepts the wrong one and the bundler does not.

## Agent skills

### Issue tracker

GitHub Issues via the `gh` CLI, account `augustov58`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context, but the glossary and ADRs live in the Obsidian vault, not under `docs/adr/` here. See `docs/agents/domain.md`.
