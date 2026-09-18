# Project Context: Engineer Project Management OS

*Last updated: 2026-09-14*

## What this is

This repo is the code workspace for the Engineer Project Management OS, an internal operations dashboard for engineering projects with a Pi AI copilot.

## Source of truth

All planning documentation lives in the Obsidian vault. This vault location is the single source of truth and MUST be kept current:

```
/home/augusto/Obsidian Notes/Projects/Engineer Project Management OS/
├── PRD and Architecture.md   ← requirements, architecture, the six-step sequence and its status
├── Post-MVP PRD.md           ← the post-MVP plan, inheriting the above by reference
├── docs/
│   ├── adr/                  ← architecture decisions, and README.md, the index
│   ├── design/               ← the approved design brief and the mockups (ADR-0059, issue #116)
│   └── glossary.md           ← domain terms
```

**Update rules:**
- When a milestone is completed, mark it in `PRD and Architecture.md`, beside the sequence it belongs to.
- When a slice lands, append a row to [docs/changelog.md](./docs/changelog.md) — one row per slice, and the only per-slice record.
- Any plan adjustment, scope change, or new decision gets documented in the vault (as an ADR if architectural), and the ADR index updated.
- Do not treat this file or AGENTS.md as the plan. The vault files are authoritative.

## This file is a pointer, and it is not the glossary

It holds the vault pointer and the update rules above, and nothing that is a copy of a record
kept elsewhere — a decision settled 2026-09-08 by ADR-0051 and built as issue #110. The vault's
`docs/glossary.md` is the only glossary; a second one in this repo would be a second place a
binding fact lives, free to disagree, and the vault has produced exactly that failure twice.

What this file used to carry, and where each now lives:

| Was here | Is now |
|---|---|
| The decision table | The vault's `docs/adr/README.md`, which is the index it summarised |
| The per-slice milestone table | [docs/changelog.md](./docs/changelog.md), one row per slice |
| The six-step sequence's status | `PRD and Architecture.md`, beside the sequence |
| The open-decisions list | The vault `docs/adr/README.md`'s `## Open, deliberately` |
