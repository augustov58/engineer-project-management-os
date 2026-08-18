# Project Context: Engineer Project Management OS

*Last updated: 2026-08-18*

## What this is

This repo is the code workspace for the Engineer Project Management OS, an internal operations dashboard for engineering projects with a Pi AI copilot.

## Source of truth

All planning documentation lives in the Obsidian vault. This vault location is the single source of truth and MUST be kept current:

```
/home/augusto/Obsidian Notes/Projects/Engineer Project Management OS/
├── PRD and Architecture.md   ← requirements, architecture, milestones, backlog
├── docs/
│   ├── adr/                  ← architecture decisions 0001-0011
│   └── glossary.md           ← domain terms
```

**Update rules:**
- When a milestone is completed, update the progress section below and mark it in `PRD and Architecture.md`.
- Any plan adjustment, scope change, or new decision gets documented here AND in the vault (as an ADR if architectural).
- Do not treat this file or AGENTS.md as the plan. The vault files are authoritative.

## Key decisions (from vault ADRs)

| # | Decision |
|---|----------|
| 0001 | Multi-firm tenancy via DB-per-firm |
| 0002 | Pi SDK isolated behind `AgentRunService` port |
| 0003 | Cloud-managed deployment, full stack retained |
| 0004 | Tiered agent autonomy (pending confirmation) |
| 0005 | Managed OIDC + RBAC (no ABAC) |
| 0006 | CSV-only imports (milestones, tasks, budget lines) |
| 0007 | Health score v1: banded overdue ratio |
| 0008 | Doc metadata via cloud OCR + Pi extraction, human-confirmed |
| 0009 | Email ingest via forward-to-address |
| 0010 | Daily brief as in-app digest |
| 0011 | Risk register: manual + agent-proposed |

## Stack

TypeScript monorepo · Next.js · Node.js API (Fastify/NestJS) · PostgreSQL + Prisma · Redis + BullMQ · S3 object storage · `@earendil-works/pi-coding-agent` SDK

## Milestones and progress

| Phase | Scope | Status |
|-------|-------|--------|
| Phase 0 | Pi SDK integration spike | Not started |
| Phase 1 | Core foundation (auth, org, projects, tasks, DB, dashboard shell) | Not started |
| Phase 2 | Engineering workflows (RFIs, submittals, docs, health score) | Not started |
| Phase 3 | Pi copilot MVP (streaming, read-only tools, approvals) | Not started |
| Phase 4 | Hardening (tests, audit, deploy, import/export) | Not started |

## Open decisions (deferred to implementation)

- Fly vs Render (hosting)
- Clerk vs Auth0 (OIDC provider)
- Textract vs Google Document AI (OCR)
- SES vs Postmark vs SendGrid (email ingest)

## Change log

| Date | Change |
|------|--------|
| 2026-08-17 | Planning complete. PRD, architecture, ADRs, and glossary finalized. |
| 2026-08-18 | Code workspace created. Development not yet started. |
