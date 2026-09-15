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
- An item's **owner is a user** since issue #112 (ADR-0055 part 5): `owner_id`, **required**,
  set from the session when the item is raised. The create body carries no owner at all —
  there is nothing for it to say — so `openItemBodySchema` names none, and a client still
  sending one gets a 400 rather than a stripped key. Handing it on is
  `POST /v1/open-items/:id/owner`, allowed on a resolved item too: whose the work was is not
  a fact about whether it is finished. Do not restore a free-text owner and do not make the
  column nullable: *nobody* is a real answer on **waiting on** and never was on this one.
- The owner goes out **named** through `openItemOnTheWire`, and every read of an item goes
  through it — the five on this record, the four other records that name what they are being
  chased for (`chasedItems` in `wire.ts`), and nothing else. A bare `owner_id` reaching a
  screen is the defect that projection exists to prevent; the **export** is the exception and
  dumps the column raw, as it dumps `audit_entries.actor_id`.
- `GET /v1/open-items?mine=true` narrows the pending view to the caller's own, **read off the
  session and never a supplied id**: asking about somebody else is a different question and
  this one has no answer but *me*. It defaults to **false** here and to true on the screen —
  what this route means is every unresolved item across every job, and which of them an
  engineer is shown first is the screen's decision (ADR-0038's rule applied to a filter).
- An **assumption record** captures the `ASSUMPTIONS` and `FLAGS / VERIFY` blocks *verbatim*
  as two text columns — nothing trims, normalises or re-wraps them, and no route edits or
  deletes one (ADR-0029). A rerun of the calculation is another record against the same
  submission, dated its own day.
- An entry of either block is addressed by its **line number**, and every non-blank line is
  an entry. Do not parse the `- ` / `! ` sigils **the helper skills** print: they are those
  scripts' convention, not a contract, and reading them would make this refuse the next
  helper skill's output. `assumptionLines` and `flagLines` are split on every read and
  stored nowhere. This read "the three calculators" until 2026-09-13 (issue #107), matching
  ADR-0029's "all three", which its corrections of 2026-09-08 and 2026-09-11 found was never
  true in either direction: one helper was on disk when 0029 was written and four are in the
  helpers' repository now, three of them registered. **The decision rests on the sentence
  that does not count** — a further helper is free to print something else — so the number is
  gone from here rather than corrected to a new one that will also go stale.
- Counterfactuals on an assumption record are **rows**, one per assumed input, keyed by the
  line of `ASSUMPTIONS` they are about (ADR-0029, story 39) — not the single column the
  PRD sketch names. A second one on the same input is refused, matching resolve.
- A flag raised as an open item is attached to the submission **after** the issuance, so it
  makes the set *currently* provisional and puts it into exposure and never touches
  `issued_provisional` (ADR-0027). Its subject stays `PROJECT`, as every open item's does.
