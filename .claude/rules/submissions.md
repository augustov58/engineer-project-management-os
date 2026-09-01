---
paths:
  - "apps/api/src/routes/submissions.ts"
  - "apps/api/src/routes/phases.ts"
  - "apps/api/test/submissions.test.ts"
  - "apps/api/test/supersede.test.ts"
  - "apps/api/test/exposure.test.ts"
  - "apps/api/prisma/schema.prisma"
  - "apps/web/app/submission-form.tsx"
  - "apps/web/app/submissions/**"
  - "apps/web/app/exposure/**"
  - "apps/web/app/phases.tsx"
  - "apps/web/app/new-phase-form.tsx"
  - "apps/web/app/rename-phase-form.tsx"
  - "apps/web/app/projects/*/page.tsx"
---
# Submissions, phases, exposure and supersede

Ground rules moved out of `AGENTS.md` on 2026-09-01, none rewritten. Claude Code loads this file when a
path in the frontmatter is read through the Read tool; from the shell, read it yourself. The rules that
apply to every path stay in `AGENTS.md`.

- What a submission rests on is the `submission_open_items` join, never a second subject on
  the open item (ADR-0026). An open item's subject stays `PROJECT`; raising one against a
  submission attaches it and leaves it on its project. Do not add `SUBMISSION` to the
  subject enum to "simplify" this — it would have broken issues #6 and #7, and still would.
- Nothing updates a submission. There is no PATCH, no PUT and no edit route, and adding one
  is a regression against ADR-0015. A correction is `POST /v1/submissions/:id/reissue`,
  which writes a new row and nothing at all to the one it replaces (ADR-0028).
- What a set rests on is named in the same call that records it (`openItemIds`), which is
  what gives the moment of issuance something to stamp against. Attaching afterwards is the
  correction, not the entry path (ADR-0026).
- The record is a **submission**. "Issuance" is the act or the date — "issuance date", "at
  the moment of issuance" — and never the name of the record, in code or in UI copy.
- Provisional is **two** facts and neither is the other (ADR-0027). `issued_provisional` is
  stamped at the moment of issuance and never recomputed; *currently provisional* is derived
  on every read from `resolved_at` and stored nowhere. Resolving everything a set rested on
  must leave `issued_provisional` standing — that is the fact the record exists to keep.
- `submission_open_items.unresolved_at_issuance` is nullable and the null means something:
  the item was attached *after* the issuance and was no part of it. Detach is narrowed to
  exactly those rows; refusing the others is what stops cleanup erasing what went out
  (ADR-0027, settling the collision ADR-0026 recorded).
- *Superseded* is a successor existing, derived on every read and stored nowhere
  (ADR-0028) — the shape ADR-0027 gave *currently provisional*. There is no `superseded_at`
  and no flag; `submissions.supersedes_id` is unique, and that is the whole of "at most one
  successor, and the chain is linear". Do not mark the prior row: writing to it is the edit
  the record type exists to prevent.
- On a reissue, `openItemIds` **left off** carries forward what the superseded set rested
  on and **supplied** is exactly that list, so `[]` is a deliberate drop (ADR-0028). The
  successor stamps its own `unresolved_at_issuance` and `issued_provisional` at its own
  moment of issuance; the ancestor's are never rewritten.
- Exposure is a **list**, not a number (ADR-0027). `GET /v1/exposure` returns the
  submissions; every count is that list's length, so a count and the screen it links to
  cannot disagree, and there is no figure to combine into a score (ADR-0016). Archived
  projects leave the across-every-project count and keep their own, and so do superseded
  ancestors (ADR-0028) — carry-forward puts the same unresolved item on both, so counting
  the ancestor too would make the number grow by correcting the record.
