# Engineer Project Management OS

Internal operations dashboard for engineering projects (schedule, budget, RFIs, submittals, documents, risks) with a Pi-powered copilot.

## Read this first

Before any work, read [CONTEXT.md](./CONTEXT.md). It points to the authoritative plan.

## Source of truth

The Obsidian vault is the single source of truth for this project's documentation, decisions, and progress:

```
/home/augusto/Obsidian Notes/Projects/Engineer Project Management OS/
```

- `PRD and Architecture.md` - product requirements, architecture, and the six-step Revised MVP sequence. It carries **no backlog**: the 2026-08-24 grilling deleted the original fourteen-item list and never replaced it, and what is planned beyond the MVP is one sentence, the five deferred items with named triggers.
- `docs/adr/` - decision records 0001-0061, indexed with a status for every one by `docs/adr/README.md`; in the files, 0001-0011 carry a `- Status:` bullet and 0020-0061 a bare `Status:`, but **0012-0019 carry none**, so those eight have only the index. Six are superseded (0001 and 0005 by 0012, 0007 by 0016, 0012 and 0020 by 0055, 0050 by 0054) and **six** Accepted with a qualifier (0004, 0006, 0008, 0010, 0011, 0013); **none is Proposed**, none since 0020 was accepted 2026-09-01.
- `docs/glossary.md` - domain glossary.

Never let the vault docs drift from reality. Update them as work happens (see CONTEXT.md for the update rules).

## Current status

Slices 1 through 22 — issues #2 to #22, plus the deployment as #56 — are built, with the
three correctness gaps found reviewing project memory closed as issue #42 and the root
typecheck repaired as #49. That is every step of the six-step **Revised MVP sequence** in
`PRD and Architecture.md` including step 1, done 2026-09-05 on job **260001** — the four
items the PRD names are T-1's *examples* of an open item's shape, not a checklist, and
reading them as one is what kept the step open; do not re-raise it. **Step 5 is done since
#109**: consent landed 2026-09-08 and both adapters are written, so "no adapter exists" is
spent. The **inbound mail provider stays unwritten**, the last vendor pick.

**Post-MVP has started** (issue #103). Eight tickets have landed: the timezone frame (#104,
ADR-0054); **users and sessions replacing the edge gate** (#105, ADR-0055) — there is a
`users` table, a deployment's first account is a command on the machine, and no shared
secret is configured anywhere; **the gates** (#106, ADR-0052) — `.github/workflows/ci.yml`
runs every gate below on every push and pull request, and does not deploy; **the helper
skills** (#107, ADR-0053) — `apps/api/tools/` is a submodule pinned by commit at the helpers'
own repository, its manifested helpers reachable as `POST /v1/tools/:name` through the one
mutating-method route that **records nothing**; **extraction reachable** (#108, no ADR) —
the register screen asks for one over a stored document and every ask lands on the
confirmation screen; **the vendor picks** (#109, ADR-0060/0061) — `OCR=azure` is Azure AI
Document Intelligence and `TRANSCRIBER=azure` Azure AI Speech **fast** transcription, both
refusing by default, no key in source; **the actor and the subject** (#111, ADR-0055 part 2)
— every audit line says **who**, **which row** it touched and the run it was written during,
the actor coming from the session and never a request body, and **no model carries a
`created_by`**; and **the person on the record** (#112, ADR-0055 part 5) — a walk's
`conducted_by` (the report prints it), an open item's `owner_id` replacing free text, the
handoff that names who the ball came to, and *mine*/*ours* on the daily layer. Still no
`created_by`: whose a record **is** differs from who typed it. **ADR-0055 is built whole.**
The platform health check is `/healthz`, a Next route that
reaches the API, **verified on the machine that serves**; the readings are in ADR-0045. The
per-slice record is [docs/changelog.md](./docs/changelog.md) and nothing else (ADR-0051).
Work one ticket at a time, and only when asked.

`pnpm dev` starts everything; `pnpm typecheck` and `pnpm test` run from the repo root and
pass. Since issue #50 (ADR-0049) `pnpm test` covers `apps/web` too — component-level
Vitest, no browser. The frontend **build** is in neither and is CI's fourth gate (#106);
`.claude/rules/web.md` says what it catches and how to run it by hand, which is still what to
do before calling a frontend change done. The fifth is `./scripts/helper-tests.sh` (#107),
running each helper's own tests — it gates what this repository *pinned* where the others
gate what it wrote. See [README.md](./README.md).

## Ground rules for agents

- Plan changes, scope adjustments and vendor decisions get recorded in the vault, not only in code or commits.
- Milestone completion is marked in `PRD and Architecture.md` in the same session.
- Follow the ADRs; if an ADR must change, write a new/superseding ADR in the vault first.
- Stack: TypeScript monorepo (pnpm), Next.js frontend, Fastify API (ADR-0021), PostgreSQL + Prisma, Redis + BullMQ, S3 docs, Pi SDK (`@earendil-works/pi-coding-agent`).
- The product implements no calculation logic anywhere. Helper skills produce inputs to the
  record; it records what one produced and never reimplements its math.
- The glossary's `_Avoid_` lists are **binding vocabulary**, in column names as much as in
  UI copy: the observation's content column is `observed` and not `note`; the record is a
  *site visit*, never an inspection or a walkthrough; a location has no *area* or *zone*.
  Check a new column name against the glossary before writing it.
- `apps/web` imports carry no file extension (bundler resolution); `apps/api` imports carry `.js` (NodeNext). `tsc` accepts the wrong one and the bundler does not.

## Rules by path

The rules for one record live in `.claude/rules/`, one file per path family, and Claude Code
loads a file the moment a path in its frontmatter is read through the Read tool. A file
opened through the shell loads nothing, so before editing anything in the left column, read
the file on the right. Each rule there was a bullet in this file until 2026-09-01 and none
was rewritten; only `helpers.md` was written fresh, for #107.

| Before editing | Read |
|---|---|
| anything under `apps/api/` | [api.md](./.claude/rules/api.md) — the boundary and the leaves, `/v1`, the `TimeSource`, the tests |
| anything under `apps/web/` | [web.md](./.claude/rules/web.md) — native selects, the build, hydration, the morning screen |
| submissions, phases, exposure, supersede | [submissions.md](./.claude/rules/submissions.md) |
| open items, the pending view, assumption records | [open-items.md](./.claude/rules/open-items.md) |
| site visits, observations, issues, the report | [site-visits.md](./.claude/rules/site-visits.md) |
| photographs, binning, the filename grammar | [photos.md](./.claude/rules/photos.md) |
| voice captures, transcription | [voice.md](./.claude/rules/voice.md) |
| registers, entries, ball-in-court, the clock, dispositions | [registers.md](./.claude/rules/registers.md) |
| project memory, proposals, agent runs, the audit, the activity feed | [memory.md](./.claude/rules/memory.md) |
| the ingest address, documents and referenced files, extraction, processing location | [ingest.md](./.claude/rules/ingest.md) |
| the gate, users, sessions, sign-in, `proxy.ts`, `apiFetch` | [gate.md](./.claude/rules/gate.md) |
| helper skills, the manifests, `POST /v1/tools/:name`, the pinned `apps/api/tools/` | [helpers.md](./.claude/rules/helpers.md) |

`prisma/schema.prisma`, `worker.ts` and the project page are listed in every file whose
record they touch, so reading one loads all of those, on purpose. A rule about one record
goes in that record's file and never here: this file carries only what applies to every
path, and stays under 8 KB — trimmed back under it on 2026-09-15.

## Agent skills

### Issue tracker

GitHub Issues via `gh`, account `augustov58`. See `docs/agents/issue-tracker.md`.

### Domain docs

The glossary and ADRs live in the Obsidian vault, not under `docs/adr/` here. See `docs/agents/domain.md`.
