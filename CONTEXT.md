# Project Context: Engineer Project Management OS

*Last updated: 2026-08-24*

## What this is

This repo is the code workspace for the Engineer Project Management OS, an internal operations dashboard for engineering projects with a Pi AI copilot.

## Source of truth

All planning documentation lives in the Obsidian vault. This vault location is the single source of truth and MUST be kept current:

```
/home/augusto/Obsidian Notes/Projects/Engineer Project Management OS/
├── PRD and Architecture.md   ← requirements, architecture, milestones, backlog
├── docs/
│   ├── adr/                  ← architecture decisions 0001-0019 (check Status lines)
│   └── glossary.md           ← domain terms
```

**Update rules:**
- When a milestone is completed, update the progress section below and mark it in `PRD and Architecture.md`.
- Any plan adjustment, scope change, or new decision gets documented here AND in the vault (as an ADR if architectural).
- Do not treat this file or AGENTS.md as the plan. The vault files are authoritative.

## Key decisions (from vault ADRs)

Twenty-two ADRs (0020 is Proposed; 0021 and 0022 were decided while building slice 1). The 2026-08-24 grilling session overturned several 2026-08-17 decisions
that rested on a false premise. Read [[docs/adr/README]] in the vault for current status;
do not treat 0001-0011 as current without checking.

**Outcome test:** every deliverable I issue states what it rests on, with nothing sitting
in my court past its clock as the daily layer under it.

| # | Decision |
|---|----------|
| 0012 | Single-user personal tool (supersedes 0001 tenancy, 0005 auth) |
| 0013 | Cloud extraction default, local fallback (qualifies 0008) |
| 0014 | Open item is the central record |
| 0015 | Submissions first-class, may be provisional |
| 0016 | Exposure + clock replace the health score (supersedes 0007) |
| 0017 | No money model (strikes budget from 0006, 0010) |
| 0018 | Capture and extraction first, copilot later (narrows 0004) |
| 0019 | No vector search; retrieval by identity |
| 0020 | Single shared secret at the edge — **Proposed**, closes the gap between 0003 and 0012 |
| 0002 | Pi SDK behind `AgentRunService` port — required by the author |
| 0003 | Cloud-managed deployment |
| 0009 | Email forward-to-ingest |
| 0011 | Risk register: manual + agent-proposed |
| 0021 | Fastify, not NestJS — decided by slice 1, not revisited |
| 0022 | Time source is a port called `TimeSource`; `Clock` stays a domain word |

## Stack

TypeScript monorepo · Next.js · Node.js API (Fastify, ADR-0021) · PostgreSQL + Prisma · Redis + BullMQ · S3 object storage · `@earendil-works/pi-coding-agent` SDK

## Milestones and progress

The five-phase plan is superseded by the revised sequence in `PRD and Architecture.md`.

| Step | Scope | Status |
|------|-------|--------|
| 0 | Walking skeleton and test harness (issue #2) | **Done** 2026-08-24 |
| 1 | T-1 open items entered | Not started |
| 2 | Open items + submissions (provisional, supersede) | Not started |
| 3 | Site visit capture (voice, photos, stable issue IDs) | Not started |
| 4 | Registers: submittals, RFIs, clock, dispositions | Not started |
| 5 | Ingest: forward-to-email, extraction, human-confirmed | Not started |
| 6 | Curated project memory | Not started |

## Open decisions (deferred to implementation)

- Fly vs Render (hosting)
- Textract vs Google Document AI (OCR)
- SES vs Postmark vs SendGrid (email ingest)
- Transcription vendor for voice-to-observation capture (step 3) — added 2026-08-24, none named in the plan

~~Clerk vs Auth0 (OIDC provider)~~ — struck 2026-08-24, dead under ADR-0012. Access control
is ADR-0020's single edge secret, which is a gate, not an identity provider.

**Two contradictions open in the vault**, recorded in `docs/adr/README.md`, neither resolved:
ADR-0013 vs the glossary on the processing-location default; and ADR-0010 / 0011 / 0006
reading Accepted while appearing in neither the MVP workflow list nor the sequence above.

## Change log

| Date | Change |
|------|--------|
| 2026-08-17 | Planning complete. PRD, architecture, ADRs, and glossary finalized. |
| 2026-08-18 | Code workspace created. Development not yet started. |
| 2026-08-24 | Grilling session: 8 superseding ADRs (0012-0019), glossary rewritten to real field vocabulary, MVP resequenced. Money model, health score, RBAC, and vector search cut. |
| 2026-08-24 | Slice 1 built (issue #2): pnpm monorepo, Fastify API, Next.js frontend, PostgreSQL + Prisma migrations, Redis + BullMQ idle, and the test harness every later slice copies. ADR-0021 (Fastify) and ADR-0022 (`TimeSource`) recorded; the PRD stack line no longer says "Fastify or NestJS". |
| 2026-08-24 | Full-MVP spec written and published as GitHub issue #1 (`ready-for-agent`), covering all 7 workflows and all 6 sequence steps. Vault updated with what the spec decided: ADR-0020 (Proposed), provisional split into historical + derived, ball-in-court as a history, report renders to PDF, transcription vendor added to the open picks. Two vault contradictions surfaced and recorded, not resolved. |
