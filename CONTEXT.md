# Project Context: Engineer Project Management OS

*Last updated: 2026-08-25*

## What this is

This repo is the code workspace for the Engineer Project Management OS, an internal operations dashboard for engineering projects with a Pi AI copilot.

## Source of truth

All planning documentation lives in the Obsidian vault. This vault location is the single source of truth and MUST be kept current:

```
/home/augusto/Obsidian Notes/Projects/Engineer Project Management OS/
├── PRD and Architecture.md   ← requirements, architecture, milestones, backlog
├── docs/
│   ├── adr/                  ← architecture decisions 0001-0028 (check Status lines)
│   └── glossary.md           ← domain terms
```

**Update rules:**
- When a milestone is completed, update the progress section below and mark it in `PRD and Architecture.md`.
- Any plan adjustment, scope change, or new decision gets documented here AND in the vault (as an ADR if architectural).
- Do not treat this file or AGENTS.md as the plan. The vault files are authoritative.

## Key decisions (from vault ADRs)

Twenty-eight ADRs (0020 is Proposed; 0021 and 0022 were decided while building slice 1, 0023 while building slice 2, 0024 while building slice 3, 0025 by the author after slice 3, 0026 while building slice 4, 0027 while building slice 5, and 0028 while building slice 6). The 2026-08-24 grilling session overturned several 2026-08-17 decisions
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
| 0023 | API routes carry a `/v1` prefix — settles the spec's "versioned prefix" against slice 1's unversioned routes |
| 0024 | An open item's `unresolved` column, `resolved_at` + `resolution_note` as the whole of resolution, and `subject_type` as a one-value enum |
| 0025 | The interface is designed, not incidental — Tailwind + shadcn/ui, owned in-repo; the site visit report is a separate print problem |
| 0026 | What a submission rests on is a join table, not a second subject on the open item; a phase is a row the submission points at, and renaming it propagates |
| 0027 | Provisional is two columns and no more; detaching is narrowed to what was attached after the issuance; exposure is a list whose length is the count |
| 0028 | Superseded is a successor existing, derived and never stored; `supersedes_id` is unique, which is the whole of "at most one successor"; exposure counts only the current issuance |

## Stack

TypeScript monorepo · Next.js · Node.js API (Fastify, ADR-0021) · PostgreSQL + Prisma · Redis + BullMQ · S3 object storage · `@earendil-works/pi-coding-agent` SDK

## Milestones and progress

The five-phase plan is superseded by the revised sequence in `PRD and Architecture.md`.

| Step | Scope | Status |
|------|-------|--------|
| 0 | Walking skeleton and test harness (issue #2) | **Done** 2026-08-24 |
| 0b | `Project` record: create, list live, view, archive (issue #3) | **Done** 2026-08-25 |
| 0c | Open items + the pending items view (issue #4) | **Done** 2026-08-25 |
| 0d | Submissions, per-project phases, sheet list, revision (issue #5) | **Done** 2026-08-25 |
| 0e | Provisional state and exposure (issue #6) | **Done** 2026-08-25 |
| 0f | Reissue and supersede (issue #7) | **Done** 2026-08-25 |
| 1 | T-1 open items entered | Unblocked — no code needed |
| 2 | Open items + submissions (provisional, supersede) | **Done** — issues #4, #5, #6, #7 |
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
| 2026-08-25 | Slice 3 built (issue #4): the **open item** — create against a project, resolve with a note and a date, reopen, and the cross-project **pending items** view, filterable by who owes the next move and sorted by age. ADR-0024 records the three things the PRD's data-model sketch left out: a column for what is unresolved, a resolution model, and `subject_type` as a one-value enum. Glossary gained **Counterfactual**, **Waiting on**, **Owner**, **Resolved** and **Pending items**, none of which had an entry. |
| 2026-08-25 | Slice 2 built (issue #3): the `Project` record — create, list live, view one, archive one-way — behind a `/v1` prefix (ADR-0023). `skeleton_records` dropped, as slice 1 said it should be. Glossary gained **Project number** and **Archived**, which had no entry anywhere, and the stale **Project** and **Milestone** definitions were corrected. |
| 2026-08-24 | Full-MVP spec written and published as GitHub issue #1 (`ready-for-agent`), covering all 7 workflows and all 6 sequence steps. Vault updated with what the spec decided: ADR-0020 (Proposed), provisional split into historical + derived, ball-in-court as a history, report renders to PDF, transcription vendor added to the open picks. Two vault contradictions surfaced and recorded, not resolved. |
| 2026-08-25 | Slice 6 built (issue #7): **reissue and supersede**. Correcting an issuance records a new submission carrying `supersedes_id` and writes nothing at all to the one it replaces, so "no path edits an issued submission" holds because no such route exists — a test asserts `PATCH`, `PUT` and `DELETE` on a submission are refused with the record unchanged after. ADR-0028 records the three things left open: *superseded* is derived from a successor existing rather than stored, which settles the spec's "never edited beyond being marked superseded" against ADR-0026 in the vault's favour; "at most one successor, and the chain is linear" is a unique constraint on the column rather than a guard; and exposure excludes superseded ancestors, a filter ADR-0027 did not authorise and which carry-forward makes necessary. What the superseded set rested on comes forward by default and is editable before committing, with the successor's own snapshot stamped fresh. Glossary **Reissue** gained what was built; **Submission** and **Exposure** were amended. A frontend bug found by loading the page: a state update made from a ref during the hydration commit is discarded, so the "going out on N unresolved items" warning claimed nothing while two boxes sat ticked. |
| 2026-08-25 | Slice 5 built (issue #6): **provisional state** and **exposure**. Provisional is two facts and the record now keeps both — `issued_provisional` stamped at the moment of issuance and never recomputed, and *currently provisional* derived on every read and stored nowhere — so resolving everything a set rested on takes it out of exposure without unsaying that it went out on unconfirmed inputs. ADR-0027 records the three things neither the sketch nor ADR-0026 settled: the snapshot is one nullable boolean on `submission_open_items` carrying three real states, not two columns admitting a meaningless fourth; detaching is narrowed to items attached after the issuance, which settles the collision ADR-0026 flagged for this ticket rather than moving the snapshot off the table; and exposure is a list whose length is the count, so clicking a count lands on exactly the records it counted and there is no figure in the payload to combine into a score (ADR-0016). Archived projects leave the across-every-project count and keep their own, following the glossary's line under **Pending items**. Glossary **Provisional** and **Exposure** both gained what was built. |
| 2026-08-25 | Slice 4 built (issue #5): the **submission** — a dated issuance to a named recipient at a phase, with sheet list and revision — and per-project **phases**, defined, renamed and reordered as free text, with a current phase a new submission defaults to. ADR-0026 records the two things the sketch left out: what an issuance rests on is a `submission_open_items` join rather than a second subject on the open item, because reading ADR-0024's enum expectation literally would have made issue #7's carry-forward destroy the record of what the original rested on; and a phase is a foreign key, so a rename propagates on purpose. No route updates a submission, so issue #7's edit prohibition holds by construction. Glossary gained **Current phase**, **Sheet list**, **Revision** and **Rests on**. |
