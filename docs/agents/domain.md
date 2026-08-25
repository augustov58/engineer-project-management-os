# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring
the codebase.

**Layout: single-context, with the domain docs held outside the repo.** There is one
context. Its glossary and ADRs live in the Obsidian vault, not under `docs/adr/` here.
Reading only the repo root will find nothing and silently proceed — read the vault.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the entry pointer, plus the update rules and the
  current decision table. It is not the glossary.
- **`<vault>/docs/glossary.md`** — the glossary. This is the file the "use the glossary's
  vocabulary" rule below refers to.
- **`<vault>/docs/adr/`** — read ADRs that touch the area you're about to work in. Start
  from `<vault>/docs/adr/README.md`, which carries the status of all 26.
- **`<vault>/PRD and Architecture.md`** — problem, goals, non-goals, MVP workflows,
  architecture, and the current build sequence.

where `<vault>` is:

```
/home/augusto/Obsidian Notes/Projects/Engineer Project Management OS/
```

There is no `CONTEXT-MAP.md` and no monorepo split. If one is added later, this file
changes with it.

## File structure

```
/                                          ← this repo (code workspace)
├── CONTEXT.md                             ← entry pointer + decision table
├── AGENTS.md                              ← CLAUDE.md is a symlink to this
└── docs/agents/                           ← these files

<vault>/                                   ← source of truth (docs)
├── PRD and Architecture.md
└── docs/
    ├── adr/                               ← 0001-0027 + README.md index
    └── glossary.md
```

## Check ADR status before relying on one

ADRs 0001-0011 date from 2026-08-17 and rest on a premise the 2026-08-24 session
overturned. Three are superseded, three qualified, one scope-narrowed. **Never cite an ADR
by number without reading its `Status:` line first.** `README.md` in the ADR directory is
the index of record.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a
hypothesis, a test name), use the term as defined in `<vault>/docs/glossary.md`. Don't
drift to synonyms the glossary explicitly avoids — several terms carry an `_Avoid_` line
naming the exact wrong word, because the wrong word is the one the industry uses.

If the concept you need isn't in the glossary yet, that's a signal — either you're
inventing language the project doesn't use (reconsider) or there's a real gap (note it for
`/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently
overriding:

> _Contradicts ADR-0014 (open item as the central record) — but worth reopening because…_

Per `AGENTS.md`, a decision that must change gets a new superseding ADR written in the
vault **first**, not a quiet edit to the old one.

## Writing back

Plan changes, scope adjustments, and vendor decisions get recorded in the vault, not only
in code or commits. Glossary terms get captured the moment they're resolved, inline — not
batched to the end of a session.
