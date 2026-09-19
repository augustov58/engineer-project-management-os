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
- `docs/adr/` - decision records 0001-0061. `docs/adr/README.md` is the index and **the only place with a status for every one**: in the files 0001-0011 carry a `- Status:` bullet and 0020-0061 a bare `Status:`, and **0012-0019 carry none**. Six are superseded and six Accepted with a qualifier; **none is Proposed** since 0020, 2026-09-01.
- `docs/glossary.md` - domain glossary.

Never let the vault docs drift from reality. Update them as work happens (see CONTEXT.md for the update rules).

## Current status

Slices 1 through 22 — issues #2 to #22, plus the deployment as #56 — are built, with #42's
three correctness gaps closed and #49's root typecheck repaired. That is every step of the
six-step **Revised MVP sequence** in `PRD and Architecture.md`, step 1 included: done
2026-09-05 on job **260001**, the four items the PRD names being T-1's *examples* of an open
item's shape and not a checklist. Do not re-raise it. **Step 5 is done since #109**. The
**inbound mail provider stays unwritten**, the last vendor pick.

**Post-MVP has started** (issue #103). Eleven tickets have landed: the timezone frame (#104,
ADR-0054); **users and sessions replacing the edge gate** (#105, ADR-0055) — a `users`
table, the first account a command on the machine, no shared secret anywhere;
**the gates** (#106, ADR-0052) — `.github/workflows/ci.yml`
runs every gate below on every push and PR, and does not deploy; **the helper
skills** (#107, ADR-0053) — `apps/api/tools/` is a submodule pinned by commit at the helpers'
own repository, its manifested helpers reachable as `POST /v1/tools/:name` through the one
mutating route that **records nothing**; **extraction reachable** (#108); **the vendor
picks** (#109, ADR-0060/0061) — `OCR=azure` is Azure AI Document Intelligence and
`TRANSCRIBER=azure` Azure AI Speech **fast**, both refusing by default, no key in source;
**the actor and the subject** (#111, ADR-0055 part 2) — every audit line says **who**,
**which row** it touched and the run it was written during, the actor coming from the session
and never a request body; and **the person on the record** (#112, ADR-0055 part 5) — a walk's
`conducted_by` (the report prints it), an open item's `owner_id` replacing free text, the
handoff that names who the ball came to, and *mine*/*ours* on the daily layer. Still no
`created_by`: whose a record **is** differs from who typed it. **ADR-0055 is built whole.**
**Evidence** (#113, ADR-0056) — `photos.observation_id` beside `issue_id`, at most one; a
finding's evidence is **derived** through its sightings. **The conversation** (#114, ADR-0057
as amended by ADR-0058) — a walk has exactly one, created with it; `voice_captures` is now
`turns` under it, a capture is **spoken or typed**, and a typed one queues a run whose reply
is a turn carrying the draft or a question. The run is an `agent_runs` row naming its
conversation — the link, not the `kind` column ADR-0040 refused. **Confirming is still the
engineer's**, and the forms are unchanged. **the design system**
(#117, ADR-0059 point 4) — the brief's tokens, the dark theme on with a `users.theme` override,
every screen measured in both themes; and **the field screens redesigned to the plates** (#118,
ADR-0059 point 3), which changed **no route**.
`/healthz` is the platform check (ADR-0045); the per-slice record is
[docs/changelog.md](./docs/changelog.md) and nothing else (ADR-0051). Work one ticket at a
time, and only when asked.

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
path, and stays under 8 KB — trimmed back under it on 2026-09-15 and again on 2026-09-16.

## Agent skills

### Issue tracker

GitHub Issues via `gh`, account `augustov58`. See `docs/agents/issue-tracker.md`.

### Domain docs

The glossary and ADRs live in the Obsidian vault, not under `docs/adr/` here. See `docs/agents/domain.md`.
