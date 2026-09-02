---
paths:
  - "apps/api/src/routes/open-items.ts"
  - "apps/api/src/routes/assumption-records.ts"
  - "apps/api/test/open-items.test.ts"
  - "apps/api/test/assumption-records.test.ts"
  - "apps/api/prisma/schema.prisma"
  - "apps/web/app/pending/**"
  - "apps/web/app/open-item.tsx"
  - "apps/web/app/new-open-item-form.tsx"
  - "apps/web/app/assumption-record.tsx"
  - "apps/web/app/assumption-record-form.tsx"
  - "apps/web/app/projects/*/page.tsx"
---
# Open items, the pending view and assumption records

Ground rules moved out of `AGENTS.md` on 2026-09-01, none rewritten. Claude Code loads this file when a
path in the frontmatter is read through the Read tool; from the shell, read it yourself. The rules that
apply to every path stay in `AGENTS.md`.

- An open item is unresolved exactly when `resolved_at` is null (ADR-0024). Exposure, provisional state and the pending items view all read that one column — do not add a status field beside it.
- An **assumption record** captures the `ASSUMPTIONS` and `FLAGS / VERIFY` blocks *verbatim*
  as two text columns — nothing trims, normalises or re-wraps them, and no route edits or
  deletes one (ADR-0029). A rerun of the calculation is another record against the same
  submission, dated its own day.
- An entry of either block is addressed by its **line number**, and every non-blank line is
  an entry. Do not parse the `- ` / `! ` sigils the three calculators print: they are those
  scripts' convention, not a contract, and reading them would make this refuse the next
  helper skill's output. `assumptionLines` and `flagLines` are split on every read and
  stored nowhere.
- Counterfactuals on an assumption record are **rows**, one per assumed input, keyed by the
  line of `ASSUMPTIONS` they are about (ADR-0029, story 39) — not the single column the
  PRD sketch names. A second one on the same input is refused, matching resolve.
- A flag raised as an open item is attached to the submission **after** the issuance, so it
  makes the set *currently* provisional and puts it into exposure and never touches
  `issued_provisional` (ADR-0027). Its subject stays `PROJECT`, as every open item's does.
