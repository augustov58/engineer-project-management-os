# Engineer Project Management OS

Internal operations dashboard for engineering projects (schedule, budget, tasks, RFIs, submittals, documents, risks) with a Pi-powered copilot.

## Read this first

Before any work, read [CONTEXT.md](./CONTEXT.md). It points to the authoritative plan.

## Source of truth

The Obsidian vault is the single source of truth for this project's documentation, decisions, and progress:

```
/home/augusto/Obsidian Notes/Projects/Engineer Project Management OS/
```

- `PRD and Architecture.md` - product requirements, architecture, and the six-step Revised MVP sequence. It carries **no backlog**: the 2026-08-24 grilling deleted the original fourteen-item list and never replaced it, and what is planned beyond the MVP is one sentence, the five items deferred with named triggers.
- `docs/adr/` - architecture decision records 0001-0045; check each `Status:` line. Three are superseded (0001, 0005, 0007) and six are Accepted with a qualifier; **none is Proposed** — 0020 was the last one and was accepted 2026-09-01.
- `docs/glossary.md` - domain glossary.

Never let the vault docs drift from reality. Update them as work happens (see CONTEXT.md for the update rules).

## Current status

Slices 1 through 22 — issues #2 to #22, plus the deployment as #56 — are built, with the three correctness gaps found
reviewing project memory closed as issue #42 and the root typecheck repaired as issue #49.
That is every step of the six-step **Revised MVP sequence** in `PRD and Architecture.md`
except step 1, entering T-1's own open items, which needs no code and is the author's to do;
what remains of step 5 is the OCR adapter and its vendor pick, which is where employer
consent now attaches. The per-slice record is the milestone table in
[CONTEXT.md](./CONTEXT.md) and the change log in [docs/changelog.md](./docs/changelog.md).
Work one ticket at a time, and only when asked.

`pnpm dev` starts everything; `pnpm typecheck` and `pnpm test` each run from the repo root
and each pass. The frontend build is **not** part of either — `.claude/rules/web.md` says
what it catches and how to run it. See [README.md](./README.md).

## Ground rules for agents

- Plan changes, scope adjustments, and vendor decisions get recorded in the vault, not only in code or commits.
- Milestone completion updates the vault progress section in the same session.
- Follow the ADRs; if an ADR must change, write a new/superseding ADR in the vault first.
- Stack: TypeScript monorepo (pnpm), Next.js frontend, Fastify API (ADR-0021), PostgreSQL + Prisma, Redis + BullMQ, S3 docs, Pi SDK via `@earendil-works/pi-coding-agent`.
- The product implements no calculation logic anywhere. Helper skills produce inputs to the
  record; the product records what one produced and never reimplements its math.
- The glossary's `_Avoid_` lists are **binding vocabulary**, in column names as much as in
  UI copy. The observation's content column is `observed` and not `note` for that reason;
  the record is a *site visit*, never an inspection or a walkthrough; and a location has no
  *area* or *zone*. Check a new column name against the glossary before writing it.
- `apps/web` imports carry no file extension (bundler resolution); `apps/api` imports carry `.js` (NodeNext). `tsc` accepts the wrong one and the bundler does not.

## Rules by path

The rules for one record live in `.claude/rules/`, one file per path family, and Claude Code
loads a file the moment a path in its frontmatter is read through the Read tool. A file
opened through the shell loads nothing, so before editing anything in the left column, read
the file on the right. Every rule there was a bullet in this file until 2026-09-01, and none
was rewritten.

| Before editing | Read |
|---|---|
| anything under `apps/api/` | [api.md](./.claude/rules/api.md) — the boundary and the leaves, `/v1`, the `TimeSource`, the test policy |
| anything under `apps/web/` | [web.md](./.claude/rules/web.md) — native selects, the build, hydration, the morning screen |
| submissions, phases, exposure, supersede | [submissions.md](./.claude/rules/submissions.md) |
| open items, the pending view, assumption records | [open-items.md](./.claude/rules/open-items.md) |
| site visits, observations, issues, the report | [site-visits.md](./.claude/rules/site-visits.md) |
| photographs, binning, the filename grammar | [photos.md](./.claude/rules/photos.md) |
| voice captures, transcription | [voice.md](./.claude/rules/voice.md) |
| registers, entries, ball-in-court, the clock, dispositions | [registers.md](./.claude/rules/registers.md) |
| project memory, proposals, agent runs, the audit | [memory.md](./.claude/rules/memory.md) |
| the ingest address, documents and referenced files, extraction, the processing location | [ingest.md](./.claude/rules/ingest.md) |
| the edge gate, `EDGE_SECRET`, `proxy.ts`, `apiFetch` | [edge-gate.md](./.claude/rules/edge-gate.md) |

`prisma/schema.prisma`, `worker.ts` and the project page are listed in every file whose
record they touch, so reading one of them loads all of those, on purpose. A rule about one
record goes in that record's file and never here: this file carries only what applies to
every path, and stays under 8 KB.

## Agent skills

### Issue tracker

GitHub Issues via the `gh` CLI, account `augustov58`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context, but the glossary and ADRs live in the Obsidian vault, not under `docs/adr/` here. See `docs/agents/domain.md`.
