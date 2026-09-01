---
paths:
  - "apps/api/src/routes/site-visits.ts"
  - "apps/api/src/routes/issues.ts"
  - "apps/api/src/routes/reports.ts"
  - "apps/api/src/routes/projects.ts"
  - "apps/api/src/report.ts"
  - "apps/api/src/pdf.ts"
  - "apps/api/src/worker.ts"
  - "apps/api/test/site-visits.test.ts"
  - "apps/api/test/issues.test.ts"
  - "apps/api/test/reports.test.ts"
  - "apps/api/test/projects.test.ts"
  - "apps/api/prisma/schema.prisma"
  - "apps/web/app/site-visit-form.tsx"
  - "apps/web/app/site-visits/**"
  - "apps/web/app/site-visit-reports/**"
  - "apps/web/app/issue-form.tsx"
  - "apps/web/app/report-form.tsx"
  - "apps/web/app/projects/*/issues/**"
  - "apps/web/app/projects/*/page.tsx"
---
# Site visits, observations, issues and the report

Ground rules moved out of `AGENTS.md` on 2026-09-01, none rewritten. Claude Code loads this file when a
path in the frontmatter is read through the Read tool; from the shell, read it yourself. The rules that
apply to every path stay in `AGENTS.md`.

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
  and where is read through the sightings, and what a report prints is the walk's own — the
  choice issue #13 made out of that list (ADR-0035).
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
- A **site visit report** is a record of a **rendering**, not a document kept up to date
  (ADR-0035). Nothing edits one; `POST /v1/site-visits/:id/reports` writes another row every
  time it is called, which is ADR-0028's reissue shape and ADR-0029's rerun shape arriving
  for a third record. There is therefore **no retry route** — the departure from a voice
  capture, whose audio is irreplaceable and whose phone has already let go of it, where a
  report's every input is still in the database. Generating again is also how a report is
  regenerated once a finding that had no photograph has one (story 66).
- A report's state is **four stamps** derived on read — `rendering_since`, `rendered_at` +
  `storage_key`, `failed_at` + `failure`, and *queued* is all four null — with no status
  column beside them (ADR-0035). Fourth record asked and fourth to refuse: ADR-0024 made
  `resolved_at` the whole of unresolved, ADR-0031 made `closed_at` the whole of closed, and
  ADR-0034 read a capture the same way. Nothing here is ever cleared, unlike a retried
  capture's failure, because a second attempt is a second row and this one keeps saying what
  happened to the first.
- A report **owns nothing it prints** (ADR-0035). The project metadata, the per-floor
  schedule, the observations and the findings are read at the moment of rendering and copied
  into no column, so a report cannot come to disagree with the record it is a rendering of.
- An issue's identifier prints as **`Issue N`** — the record's name and the integer
  (ADR-0035). This is the one format decision ADR-0031 and ADR-0032 both deferred to issue
  #13 by name, and it invents nothing: it is ADR-0030's floor rule, where the column holds
  `3` and the render supplies the word, and it is what the filename grammar already carries
  in as `issue-7`. `T-1-007` is refused, as ADR-0031 refused `T-12-003` — a composed
  identifier is a second format for a number that already has one, and the project is named
  in the header block above every finding anyway.
- The report prints **this walk's sightings, and all of them** (ADR-0035) — the other
  question ADR-0031 handed to #13 by name. ADR-0032 had already reasoned the same way about
  evidence: July's photograph does not evidence August's re-observation. It is the same
  `where` clause `GET /v1/site-visits/:id/issues-without-photos` already uses.
- **The renderer is not behind a port** (ADR-0035), deliberately departing from `TimeSource`,
  `ObjectStore` and `Transcriber`. Each of those defers a pick no test can exercise — a
  bucket that does not exist, a vendor account nobody has chosen. Chrome needs no account, no
  key, no network and no per-call cost, and puppeteer pins its own, so a port would defer
  nothing and would cost the acceptance test its subject: the ticket requires asserting on
  the resulting *document*. The test for a port is whether the thing behind it is a **pick**.
- Rendering runs **on BullMQ** (ADR-0035) — ADR-0034's case and not ADR-0032's, because it
  launches a browser, decodes every photograph on the walk and lays out a paginated
  document. One queue and a second job name, dispatched on `job.name` inside `buildWorker`;
  concurrency stays 1, because one browser printing at a time is the right number on one
  machine.
- `site_visit_reports.storage_key` is **nullable**, which inverts ADR-0032's bytes-before-row
  order for the only reason that could (ADR-0035): the queue sits between the row and the
  document. The invariant itself holds — the key is written in the same statement as
  `rendered_at`, after the object is stored, so a key never points at bytes that are not
  there. There is no `content_type` column: a report is always `application/pdf`, and a
  column holding one value forever is a place for it to one day hold another.
- **`letter-spacing` above about a tenth of an em destroys a PDF's text layer.** Chrome emits
  every glyph as its own text run, so a tracked-out heading prints as `N O TA B L E …` —
  unsearchable and uncopyable in the one artifact this product issues outside itself
  (ADR-0035). Measured on this stack: it breaks at `0.11em` and is fine at `0.09em`. Screen
  CSS habits do not carry to a document.
- Photographs are inlined into the report as **data URIs** and bounded to 70mm tall
  (ADR-0035). The renderer is handed one string and needs nothing reachable over the network,
  where a linked `<img>` would need the API reachable from inside the process serving it; the
  bound is there because a portrait phone photograph is otherwise a page each. Every value
  printed is **HTML-escaped** — what was observed is free text the engineer spoke, and this
  is the one place in the product where that text becomes markup.
