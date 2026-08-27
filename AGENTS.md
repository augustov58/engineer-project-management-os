# Engineer Project Management OS

Internal operations dashboard for engineering projects (schedule, budget, tasks, RFIs, submittals, documents, risks) with a Pi-powered copilot.

## Read this first

Before any work, read [CONTEXT.md](./CONTEXT.md). It points to the authoritative plan.

## Source of truth

The Obsidian vault is the single source of truth for this project's documentation, decisions, and progress:

```
/home/augusto/Obsidian Notes/Projects/Engineer Project Management OS/
```

- `PRD and Architecture.md` - product requirements, architecture, milestones, backlog.
- `docs/adr/` - architecture decision records 0001-0031; check each `Status:` line, several are superseded and one is only Proposed.
- `docs/glossary.md` - domain glossary.

Never let the vault docs drift from reality. Update them as work happens (see CONTEXT.md for the update rules).

## Current status

Slice 1 (walking skeleton and test harness, issue #2), slice 2 (the `Project` record,
issue #3), slice 3 (open items and the pending items view, issue #4), slice 4
(submissions and per-project phases, issue #5), slice 5 (provisional state and exposure,
issue #6), slice 6 (reissue and supersede, issue #7), slice 7 (assumption records,
issue #8), slice 8 (site visits and observations, issue #9) and slice 9 (issues with
stable per-project identifiers, issue #10) are built. The plan is the six-step **Revised
MVP sequence** in `PRD and Architecture.md`, and the MVP is ticketed as
GitHub issues #2-#22. Step 1, entering T-1's own open items, needs no further code and is
the author's to do. Work one ticket at a time, and only when asked.

`pnpm dev` starts everything; `pnpm typecheck` and `pnpm test` each run from the repo root.
See [README.md](./README.md).

## Ground rules for agents

- Plan changes, scope adjustments, and vendor decisions get recorded in the vault, not only in code or commits.
- Milestone completion updates the vault progress section in the same session.
- Follow the ADRs; if an ADR must change, write a new/superseding ADR in the vault first.
- Stack: TypeScript monorepo (pnpm), Next.js frontend, Fastify API (ADR-0021), PostgreSQL + Prisma, Redis + BullMQ, S3 docs, Pi SDK via `@earendil-works/pi-coding-agent`.
- Never call `new Date()` or `Date.now()` for a timestamp that gets persisted or aged, and never give such a column a database default — read the injected `TimeSource` (ADR-0022). Aging is tested by advancing a fake, never by sleeping.
- Tests drive the HTTP API against a real PostgreSQL and assert only on responses and subsequent reads. Build fixtures through the API, not by inserting rows.
- The one sanctioned exception is a schema invariant no route can expose — "no `users` table exists" (ADR-0012). `apps/api/test/schema.test.ts` reads `information_schema` through the harness's `tableNames()` and nothing else; it may not read domain data or write rows.
- Every route sits under `/v1` (ADR-0023), carried by the single `register` call in `apps/api/src/server.ts` rather than spelled into each path.
- An open item is unresolved exactly when `resolved_at` is null (ADR-0024). Exposure, provisional state and the pending items view all read that one column — do not add a status field beside it.
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
- The frontend is Tailwind + shadcn/ui, components owned in `apps/web/components/ui` (ADR-0025). Where a styled component would change how a control serialises into a form, keep the native element and style it. The nobody checkbox, the pending sort select, the submission phase select, the attach-an-open-item select (on a submission and on an issue), the observation's Side/Sector axis select, the finding's category select and the select that makes a sighting another sighting of a finding already on the register are all native for that reason; `apps/web/app/native-select.ts` holds the shared styling.
- `pnpm typecheck` does not compile the stylesheet and `pnpm test` does not run the frontend. Run `pnpm --filter web build` and load the pages before calling a frontend change done. Browse `http://localhost:3000`, not `127.0.0.1`: Next's dev-origin guard 403s the client chunks on the other host, so the page renders and silently never hydrates.
- A state update made from a ref callback during the **hydration** commit is discarded — the ref runs, the value is right, and the render keeps the old one. Anything a first paint must show has to be in the server's render: seed the state from props and let the ref only correct it afterwards (ADR-0028).
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
- The product implements no calculation logic anywhere. Helper skills produce inputs to the
  record; the product records what one produced and never reimplements its math.
- A **site visit** produces observations and does not own their content (ADR-0030). Its end
  is nullable, because the per-floor schedule is recorded *during* the walk and a visit has
  to exist before it is over; `POST /v1/site-visits/:id/end` stamps it once. The visit's
  **date** is the day of its start, derived on read and stored nowhere.
- The per-floor schedule is one row per floor per visit, unique on the pair, carrying a
  start and a nullable completion. That pair is the window issue #11 bins a photograph's
  timestamp against, which is why an end before a start and a completion before a start are
  both refused — a window that closed before it opened would bin every photo to nothing.
- An observation's **location** is four columns — `floor`, `qualifier`, `side`, `sector` —
  and `Floor N — <qualifier>, <Side|Sector>` is rendered from them on every read and stored
  nowhere (ADR-0030). **Exactly one** of side or sector is set: both is refused and so is
  neither, because the grammar has no optional segment. Enforced by the body schema *and*
  by a CHECK constraint, since the axes not combining is a property of the record rather
  than a habit of the interface. `side` holds `A`, never `Side A`.
- The floor is free text holding the designation without the word — `3`, `B1`, `M`, `PH` —
  on both the schedule and the observation, and is not a foreign key between them: an
  observation must be recordable on a floor nobody formally started.
- Nothing makes an observation a finding. There is no status column, no category and no
  promotion route (ADR-0030); becoming an **issue** (issue #10) is a row pointing at the
  observation and wrote nothing to it. A test asserts the exact key set an observation
  returns, so a status cannot be added without a failing test saying so.
- An issue's identifier is an integer off `projects.issues_allocated`, a **high-water mark
  and not a count** (ADR-0031), read and incremented in the transaction that writes the
  issue. Do not compute the next one from `MAX(number) + 1` or `COUNT(*) + 1`: both hand the
  same number out twice the moment a row goes away, and "never reused or renumbered" is the
  property being promised. `issues_allocated` never reaches the wire: every route that
  returns a project strips it, and a test asserts the exact key set a project comes back
  with, because a screen reading it as "issues on this job" would be wrong the first time a
  promotion was refused. What a project's issues *are* is `GET /v1/projects/:id/issues`,
  whose length is the count.
- An **issue owns no content**. No summary column and no location, whatever the PRD sketch
  names (ADR-0031): an issue re-observed on three walks has three locations, and one column
  would have to pick a walk and be silently wrong about the other two. What was seen, when
  and where is read through the sightings, and issue #13 has the whole list to choose from.
- A sighting is a row in `issue_observations`, and `observation_id` is **unique** — one
  observation, at most one issue (ADR-0031). A double tap that promoted twice would burn an
  identifier that can never be given back, since a number is never reused; two problems seen
  in one place are two observations, not one observation on two findings. Those rows are also
  the whole of the history: no per-visit status and no transition log, which would be the
  `tasks` record the data model excludes arriving by the back door.
- Closing an issue is `closed_at` plus `closure_note`, both null or both set — ADR-0024's
  shape and for its reasons (ADR-0031). Reopening clears both, and closing an already-closed
  issue is refused rather than repeated, because a second note would silently overwrite the
  reason the finding was closed. Do not add a status column beside them.
- An open item raised on an issue is the `issue_open_items` join and the item's subject stays
  `PROJECT` (ADR-0031). ADR-0030 predicted story 69 would need a second value in
  `OpenItemSubject`; **ADR-0031 overrules it** — the pending items view resolves a subject
  against `projects`, so an item subjected to an issue would arrive there with no job beside
  it, which is the opposite of what the story asks for. The subject says where an item lives;
  a join says which artifact it is being chased for.
- An issue's `category` is **text with a CHECK**, never a database enum (ADR-0031). The five,
  byte-exact: `Accessibility`, `Physical / Safety`, `Functional`, `Safety / Code`,
  `Design / Coordination`. A Prisma enum member cannot be named `Physical / Safety`, so an
  enum would put `PHYSICAL_SAFETY` on the wire with the real words in a lookup in the API and
  again in the frontend — the second place the same fact lives. Refused by the body schema at
  the boundary and by the CHECK underneath.
- Nothing deletes an issue and no route renumbers one (ADR-0031). There is no PATCH, no PUT
  and no DELETE, and a test asserts all three are 404, so "never renumbered" is true by
  construction rather than by a guard, as it is for a submission. An issue's URL carries the
  number and not the row's id — `/projects/:id/issues/:number` — because the identifier is
  the thing anybody has written down.
- The glossary's `_Avoid_` lists are **binding vocabulary**, in column names as much as in
  UI copy. The observation's content column is `observed` and not `note` for that reason;
  the record is a *site visit*, never an inspection or a walkthrough; and a location has no
  *area* or *zone*. Check a new column name against the glossary before writing it.
- `apps/web` imports carry no file extension (bundler resolution); `apps/api` imports carry `.js` (NodeNext). `tsc` accepts the wrong one and the bundler does not.

## Agent skills

### Issue tracker

GitHub Issues via the `gh` CLI, account `augustov58`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context, but the glossary and ADRs live in the Obsidian vault, not under `docs/adr/` here. See `docs/agents/domain.md`.
