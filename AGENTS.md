# Engineer Project Management OS

Internal operations dashboard for engineering projects (schedule, budget, RFIs, submittals, documents, risks) with a Pi-powered copilot.

## Read this first

Before any work, read [CONTEXT.md](./CONTEXT.md). It points to the authoritative plan.

## Source of truth

The Obsidian vault is the single source of truth for this project's documentation, decisions, and progress:

```
/home/augusto/Obsidian Notes/Projects/Engineer Project Management OS/
```

- `PRD and Architecture.md` - product requirements, architecture, and the six-step Revised MVP sequence. It carries **no backlog**: the 2026-08-24 grilling deleted the original fourteen-item list and never replaced it. What is planned beyond the MVP is the five deferred items with named triggers.
- `docs/adr/` - decision records 0001-0061. `docs/adr/README.md` is the index and **the only place with a status for every one**: in the files 0001-0011 carry a `- Status:` bullet and 0020-0061 a bare `Status:`, and **0012-0019 carry none**. Which are superseded and which Accepted with a qualifier is that index's to say, and is deliberately not tallied here.
- `docs/glossary.md` - domain glossary.

Never let the vault docs drift from reality. Update them as work happens (see CONTEXT.md for the update rules).

## Current status

Slices 1 through 22 — issues #2 to #22, plus the deployment as #56 — are built, with #42's
three correctness gaps closed and #49's root typecheck repaired. That is every step of the
six-step **Revised MVP sequence** in `PRD and Architecture.md`, step 1 included: done
2026-09-05 on job **260001**, the four items the PRD names being T-1's *examples* of an open
item's shape and not a checklist. Do not re-raise it. **Step 5 is done since #109**. The
**inbound mail provider stays unwritten**, the last vendor pick.

**Post-MVP has started** (issue #103). What has landed since is
[docs/changelog.md](./docs/changelog.md) — one row per slice and the only per-slice record
(ADR-0051) — and why each was built that way is the vault's ADR. Neither is retold here and
no count of either is kept here: the count is the thing that goes stale. **ADR-0055 is built
whole**, and **ADR-0058** save part 6, refused with its trigger.

Work one ticket at a time, and only when asked.

`pnpm dev` starts everything; `pnpm typecheck` and `pnpm test` run from the repo root and
pass. Since #50 (ADR-0049) `pnpm test` covers `apps/web` too — component-level Vitest, no
browser. The frontend **build** is in neither and is CI's fourth gate (#106);
`.claude/rules/web.md` says what it catches and how to run it by hand, which is still what to
do before calling a frontend change done. The fifth is `./scripts/helper-tests.sh` (#107) —
it gates what this repository *pinned* where the others gate what it wrote.
See [README.md](./README.md).

## Ground rules for agents

- Plan changes, scope adjustments and vendor decisions get recorded in the vault, not only in code or commits.
- Milestone completion is marked in `PRD and Architecture.md` the same session.
- Follow the ADRs; if one must change, write a new/superseding ADR in the vault first.
- Stack: TypeScript monorepo (pnpm), Next.js, Fastify (ADR-0021), PostgreSQL + Prisma, Redis + BullMQ, S3 docs, Pi SDK (`@earendil-works/pi-coding-agent`).
- The product implements no calculation logic anywhere. Helper skills produce inputs to the
  record; it records what one produced and never reimplements its math.
- **No `created_by`, on any table** (ADR-0055). Whose a record *is* differs from who typed it,
  and the audit already holds the second fact — its actor comes from the session and never
  from a request body. Check this before adding any person-shaped column.
- **Confirming is the engineer's.** A run proposes a draft; a person commits it. No route
  writes on a model's say-so, and the forms did not change when the chat arrived.
- **No key in source** (ADR-0060/0061). `OCR=azure` and `TRANSCRIBER=azure` refuse by default,
  and an unrecognised vendor name refuses too.
- **The audit is append-only.** A line already written is corrected by a dated line after it
  and never by a rewrite, so lines predating a fix still carry the shape it replaced.
- `/healthz` is the platform check (ADR-0045).
- The glossary's `_Avoid_` lists are **binding vocabulary**, in column names as much as in
  UI copy: the observation's content column is `observed` and not `note`; the record is a
  *site visit*, never an inspection or a walkthrough; a location has no *area* or *zone*; a
  **turn** is never a *message*. Check a new column name against the glossary first.
- `apps/web` imports carry no file extension (bundler resolution); `apps/api` imports carry `.js` (NodeNext). `tsc` accepts the wrong one and the bundler does not.

## Rules by path

The rules for one record live in `.claude/rules/`, one file per path family, and Claude Code
loads a file the moment a path in its frontmatter is read through the Read tool. A file
opened through the shell loads nothing, so before editing anything in the left column, read
the file on the right. Each rule there was a bullet in this file until 2026-09-01 and none
was rewritten; `helpers.md` was fresh for #107, and `voice.md` became `conversations.md`
for #114.

| Before editing | Read |
|---|---|
| anything under `apps/api/` | [api.md](./.claude/rules/api.md) — the boundary and the leaves, `/v1`, the `TimeSource`, the tests |
| anything under `apps/web/` | [web.md](./.claude/rules/web.md) — native selects, the build, hydration, the morning screen |
| submissions, phases, exposure, supersede | [submissions.md](./.claude/rules/submissions.md) |
| open items, the pending view, assumption records | [open-items.md](./.claude/rules/open-items.md) |
| site visits, observations, issues, the report | [site-visits.md](./.claude/rules/site-visits.md) |
| photographs, binning, evidence, the filename grammar | [photos.md](./.claude/rules/photos.md) |
| the walk's conversation, captures, transcription, the proposed draft | [conversations.md](./.claude/rules/conversations.md) |
| registers, entries, ball-in-court, the clock, dispositions | [registers.md](./.claude/rules/registers.md) |
| project memory, proposals, agent runs, the audit, the activity feed | [memory.md](./.claude/rules/memory.md) |
| the ingest address, documents and referenced files, extraction, processing location | [ingest.md](./.claude/rules/ingest.md) |
| the gate, users, sessions, sign-in, `proxy.ts`, `apiFetch` | [gate.md](./.claude/rules/gate.md) |
| helper skills, the manifests, `POST /v1/tools/:name`, the pinned `apps/api/tools/` | [helpers.md](./.claude/rules/helpers.md) |

`prisma/schema.prisma`, `worker.ts` and the project page are listed in every file whose
record they touch, so reading one loads all of those, on purpose. A rule about one record
goes in that record's file and never here: this file carries only what applies to every
path, and stays under 8 KB — trimmed back under it on 2026-09-15, 2026-09-16 and
2026-09-22. All three times it went over by growing a per-ticket history, which is the
changelog's job; what belongs here is the standing rule a ticket left behind, not the ticket.

## Agent skills

### Issue tracker

GitHub Issues via `gh`, account `augustov58`. See `docs/agents/issue-tracker.md`.

### Domain docs

The glossary and ADRs live in the Obsidian vault, not under `docs/adr/` here. See `docs/agents/domain.md`.
