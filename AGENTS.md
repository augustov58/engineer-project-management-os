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
- `docs/adr/` - architecture decision records 0001-0037; check each `Status:` line, several are superseded and one is only Proposed.
- `docs/glossary.md` - domain glossary.

Never let the vault docs drift from reality. Update them as work happens (see CONTEXT.md for the update rules).

## Current status

Slice 1 (walking skeleton and test harness, issue #2), slice 2 (the `Project` record,
issue #3), slice 3 (open items and the pending items view, issue #4), slice 4
(submissions and per-project phases, issue #5), slice 5 (provisional state and exposure,
issue #6), slice 6 (reissue and supersede, issue #7), slice 7 (assumption records,
issue #8), slice 8 (site visits and observations, issue #9), slice 9 (issues with
stable per-project identifiers, issue #10), slice 10 (photo binning, issue #11), slice 11
(voice capture, issue #12), slice 12 (the site visit report, issue #13), slice 13
(registers, entries and the ball-in-court history, issue #14) and slice 14
(the clock and dispositions, issue #15) are
built. `apps/api/src/server.ts` was split across thirteen files between slices 10 and 11,
as its own change and behind an identical route table (ADR-0033). The plan is the six-step **Revised MVP sequence** in `PRD and Architecture.md`, and
the MVP is ticketed as GitHub issues #2-#22. **Step 3, site visit capture, is complete** —
issues #9, #10, #11, #12 and #13 — and **step 4, registers, is complete** — issues #14 and
#15. Step 5, ingest, is next and is gated on the consent item in the vault's ADR README.
Step 1, entering T-1's own open items, needs no
further code and is the author's to do. Work one ticket at a time, and only when asked.

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
- Every route sits under `/v1` (ADR-0023), carried by the single `register` call in `apps/api/src/server.ts` rather than spelled into each path. That call is *one* call on purpose: the twelve route modules it invokes are plain functions and not Fastify plugins, because a plugin would be a second place a prefix could be added and the ADR's guarantee would become a convention (ADR-0033).
- A record type is a file under `apps/api/src/routes/`, named for the record and matching the test file that drives it (ADR-0033). Its schemas, its refusals that nothing else uses and its derive-on-read helpers live beside its routes. `server.ts` is the boundary and nothing else: the ajv setting, the prefix, and the list of record types.
- `http.ts`, `refusals.ts`, `wire.ts` and `stream.ts` are **leaves** — they import Prisma and Fastify types and nothing from a route module, which is what stops `site-visits`, `photos` and `issues` importing each other in a cycle (ADR-0033). A thing used by exactly one record lives with that record and moves into a leaf only when a second record reaches for it: the SSE machinery was written inside `routes/voice.ts` and became `stream.ts` when a walk's reports reached for it (ADR-0035), which is exactly the trigger ADR-0033 names, and the 24 voice tests pass unchanged against it. `wire.ts` holds only the read shapes two or more records return; `withDerivedState` and `withLines` are used by one each and stayed put.
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
- The glossary's `_Avoid_` lists are **binding vocabulary**, in column names as much as in
  UI copy. The observation's content column is `observed` and not `note` for that reason;
  the record is a *site visit*, never an inspection or a walkthrough; and a location has no
  *area* or *zone*. Check a new column name against the glossary before writing it.
- A photograph's bytes go to the injected `ObjectStore` port and never into the database
  (ADR-0032). The row keeps `storage_key` and that key never reaches the wire. The bytes are
  read back through `GET /v1/photos/:id/bytes` and **not** a presigned URL: that would be a
  second thing reachable without the edge gate ADR-0020 carved its one exception out of, and
  0020 is still Proposed. `apps/web` proxies the route so the browser never calls the API.
- The **filename grammar** is `/(?<![a-z])(?:issue|iss)[-_ ]?(\d+)/gi`, written down for the first
  time in ADR-0032 after ADR-0031, the glossary and the schema all recorded that it was
  written down nowhere and refused to invent it. **A marker is required and a bare integer
  never counts**: those filenames carry the floor as well as the finding, so
  `3-west stair-issue-12.jpg` opens with a bare `3`, and reading any integer as an
  identifier would bind every photograph taken on floor 3 to issue 3. Do not "simplify" it
  to the last number in the name. One distinct number or nothing.
- A photograph binds to a floor **iff exactly one** per-floor window contains its timestamp
  — both ends inclusive, open-ended while the floor is still being walked. Zero windows and
  two windows are equally unbound, because picking one of two is the guess the ticket
  refuses in the zero case (ADR-0032). Do not add a tie-break.
- Both bindings are **stamped when the photograph is added and corrected in one action**,
  not derived on read as `location`, *currently provisional* and *superseded* are
  (ADR-0032). A derived binding has nowhere to keep a correction, and a floor time fixed the
  next morning would silently move photographs between floors. There is no provenance
  column: "the engineer cleared it" and "no window contained it" are the same stored fact.
- `photos.taken_at` is **required** and never falls back to the `TimeSource`, unlike
  `observations.observed_at` — that fallback would bin a timestamp-less photograph to
  whichever floor was being walked at the moment of the request (ADR-0032). Nothing reads
  EXIF. The screen sends the file's *local wall clock* written as UTC, the same frame
  `composeInstant` puts a typed time in, because ADR-0030's timezone deferral is still open
  and mixing the two frames would bin every photograph of the afternoon to nothing.
- Photo evidence lands on the **floor** and the **finding**, never on the observation
  (ADR-0032), whatever the glossary's Observation entry used to promise. There is no
  `photo_observations` join; a photograph and the observations made on its floor are read
  together through the floor value, which is why ADR-0030 joined those columns by value.
  Binding by filename creates no **sighting** — a sighting is an observation.
- Nothing deletes a photograph and nothing rewrites its filename: the name is the mechanism,
  so a correction touches only the bindings. `PATCH`, `PUT` and `DELETE` on one are 404, as
  they are for a submission and an issue, and a test asserts it.
- Photo binning runs **in the request**, not on BullMQ, despite the PRD diagram and the spec
  stack line putting it on a worker (ADR-0032). It is date comparison and one regular
  expression. **Transcription and rendering a report are what is on the queue** (ADR-0034,
  ADR-0035) — a vendor call of unbounded duration, and a browser launched to lay out a
  paginated document, which are the two cases 0032's reasoning does not cover; everything
  else still runs in the request, and do not read those two as a general licence.
- A photograph's bytes are written to the store **before** the row that points at them, and
  never inside a transaction with it (ADR-0032). `put` is a network write against the S3
  adapter, and holding a database connection across it blows Prisma's interactive-transaction
  timeout and rolls back a row whose object already stored. An orphaned object is garbage no
  reader reaches; a row pointing at bytes that are not there is not.
- The web form sends **one request per photograph** and calls the action in a loop, which is
  a deliberate departure from the `useActionState` shape every other form uses (ADR-0032). A
  server action's body is capped at one megabyte by default — raised to 16mb in
  `next.config.ts` for one file plus overhead — and a hundred files in one body is not a
  request anybody should make. Do not "tidy" this back into a single `FormData` action.
- An identifier above `2_147_483_647` names no finding, bounded in `issueNumberInFilename`
  and again as a `maximum` on the correction route's schema (ADR-0032). `ISS-20260723131500.jpg`
  is an ordinary messaging-app name, and asking Prisma for that number on an `Int` column is a
  driver range error that 500s the add and loses the photograph.
- `apps/web/app/photos/[id]/bytes/route.ts` must `encodeURIComponent` the id it forwards.
  Next decodes `%2F` and `%23` out of a path segment before the handler sees it, so
  interpolating it raw made the Next server an open GET proxy for every API route — verified,
  fixed, and verified again against the fix (ADR-0032).
- A **voice capture** is the draft, and a draft is never a state of an observation
  (ADR-0034). `observations` gains no `draft` column and no status: committing writes an
  ordinary observation and stamps `voice_captures.observation_id`, which is the shape
  ADR-0031 gave promotion, and the exact-key-set test ADR-0030 built stays true.
- A capture's `transcript` is what the vendor heard and **nothing rewrites it**. The
  engineer's correction is the body of the commit call and becomes `observations.observed`;
  both facts are kept, which is what makes "transcription error never became record error"
  checkable. Nothing parses a transcript — no field extracted, no floor guessed, no location
  inferred — the posture ADR-0029 took toward a calculation's output and ADR-0032 toward
  EXIF.
- A capture's state is **four stamps** derived on read — `transcribing_since`, `transcript`
  + `transcribed_at`, `failed_at` + `failure` — and there is no status column beside them,
  for ADR-0024's reason and ADR-0031's. Retrying clears the failure, as reopening an issue
  clears its close.
- `voice_captures.recorded_at` is required and never falls back to the `TimeSource`, as
  `photos.taken_at` is and `observations.observed_at` is not: a recording sent when the
  signal returned would be stamped with the moment it arrived. **The observation is dated
  from it**, so reviewing a walk in the evening does not date the afternoon to the evening.
- A resend carrying the same `captureKey` is answered **200 with the existing row**, not
  refused (ADR-0034). This is a deliberate departure from the photograph's duplicate-filename
  409: a refusal cannot tell the phone whether the first attempt landed, and story 112 is
  about not losing a recording. The phone holds the audio until the API answers.
- "Leaves the audio recoverable" is three things and the third is load-bearing: the bytes
  stay in the store and are served through the API, `POST /v1/voice-captures/:id/retry`
  queues it again, and **a failed capture can still be committed** — a vendor that never
  answered must not stop the walk being written up.
- Progress is the **state** over SSE, never a percentage (ADR-0034). The stream polls
  PostgreSQL and pushes the whole list; Redis pub/sub and BullMQ events were both refused as
  a second transport for a fact that lives in one table. The route uses `reply.hijack()` and
  no Fastify plugin, so ADR-0023's single `register` call stays the only place a prefix
  could be added. The machinery is `stream.ts` since slice 12 and a walk's reports open a
  stream through the same function (ADR-0035); what a record supplies is the reader.
- The transcription vendor sits behind a `Transcriber` port with **no adapter written**
  (ADR-0034). The default refuses and says so; `TRANSCRIBER=stub` returns one fixed
  self-describing line so the review screen can be exercised, is off by default, and must
  never be set on a real walk.
- `observationBodySchema` and `observationData` are exported from `routes/site-visits.ts`
  and used by both writers of that table. ADR-0030 predicted this route and named the risk;
  do not restate the one-axis schema in `routes/voice.ts`.
- `getUserMedia` needs a secure context, so recording does not work on a phone over
  `http://<address>:3000`. The screen says so; the fix is TLS or a tunnel, not code.
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
- `startTestApi({ worker: false })` **substitutes nothing** — it does not start a worker,
  which is a state production has too: the API up with a job still sitting in Redis. It is
  how *queued* became a state a test can stand in and look at, for work with no vendor seam
  to hold open the way `heldTranscriber` holds a transcription.
- **Ball-in-court is a history and never a field** (ADR-0036). `ball_in_court_events` is one
  row per handoff; *ball-in-court* is the last of them, derived on every read and stored
  nowhere, the shape ADR-0027 gave *currently provisional*. `register_entries` has **no status
  column and no `ball_in_court` column**, and their absence is the test that this has not
  become the transition log ADR-0031 refused — it is here because an arithmetic reads it
  (issue #15 sums the intervals where the ball was ours), which a current value cannot produce
  at all. Do not add either column.
- A handoff carries `party` **and** `in_our_court`, and neither derives from the other
  (ADR-0036). The clock reads the boolean; the screen shows the name. Do not read "ours" off
  the name the way ADR-0024 reserved `nobody` on `waiting_on`: nothing computes from `nobody`,
  and a job that calls us by the firm's name still accrues. Ordered by `held_since` then
  `created_at`, because a transmittal log is written up out of order. Handing the ball to
  whoever already holds it is two intervals and is not refused.
- Both registers are written **in the same transaction as the project** and there is no create
  route and no delete (ADR-0036). `@@unique([project_id, kind])` is what makes "exactly two"
  a fact the database keeps. A register carries no state: it is the scope an entry's number is
  unique within.
- `register_kind` is a **database enum**, deliberately reversing the text-with-a-CHECK run
  (ADR-0036). ADR-0031's reason was that `Physical / Safety` cannot be a Prisma enum member;
  `SUBMITTAL` and `RFI` name themselves, so `open_item_subject` is the live precedent. The
  disposition arriving in issue #15 is text with a CHECK, by that same reasoning.
- A register entry's `number` is the **engineer's and never allocated** — the opposite of an
  issue's identifier (ADR-0031) — and is unique within its register, not within the job. The
  first handoff is named in the same call that logs the entry (ADR-0026's shape), so the
  derived current holder is never nobody. Nothing edits an entry: `PATCH`, `PUT` and `DELETE`
  are 404 and a test asserts it.
- The link to the issuance that responded is `register_entries.submission_id`, **never a column
  on the submission** (ADR-0036). Story 35 reads the same column in reverse; a column on
  `submissions` could only be written after the set went out, which is the update route
  ADR-0026 made impossible by construction. Set once; a second link is refused rather than
  repointed, as a second response is.
- Which kind carries a question is enforced **at the boundary only** (ADR-0036), unlike
  ADR-0030's one-axis rule and ADR-0031's category. The kind lives on `registers` and a CHECK
  cannot read another row; copying it onto the entry would be the second place the same fact
  lives. The one CHECK that is reachable is written: a response without a question is
  impossible.
- An open item on a register entry is the `register_entry_open_items` join and the item's
  subject stays `PROJECT` (ADR-0036) — the third record to answer this way. The spec's
  `### Core records` line still names a register entry as a `subject_type`; it is overruled.
  If a change touches the pending items view to make story 79 work, it is wrong.
- The clock is an **arithmetic over the handoff history** and never a column (ADR-0037).
  `inCourtMs` sums the intervals whose handoff says `in_our_court` — each opened by a handoff
  and closed by the next, the last running to `timeSource.now()`. There is no `clock_started`,
  though the PRD sketch names one: the ball reaches us more than once, so there is no single
  moment a clock began, and a column meaning "the first time" would answer the wrong question
  the second time. There is no `clock_stopped` either. The open interval clamps at zero,
  because a handoff may be dated forward and a negative one would subtract time the entry
  never spent with us.
- *Past its clock* is **three facts** and the first is that the ball is **ours now**
  (ADR-0037) — the outcome test is "nothing sitting in *my court* past its clock". That is
  what takes a disposed entry off the list with nothing having to stop a clock, and what keeps
  the predicate honest: an entry handed back is not sitting in our court however long it took
  us, and what it took us stays on the record as `inCourtMs`. A target must be set (no target
  is never past) and elapsed must *exceed* it (exactly the target is not past). `pastClock` is
  computed in one place, so a badge and the view cannot disagree about the same entry.
- Recording a disposition **stops the clock by handing the ball back** — the terminal event
  ADR-0036 left room for, taken so that this slice adds no mechanism (ADR-0037). One call and
  one transaction: it stamps `disposition` and `disposed_at` and writes a handoff. The
  handoff's party is **supplied** and never read off `from_party`: an entry's two parties are
  its fixed cast and ADR-0036 forbids reading them as whose move it is, so a route that
  guessed would write a handoff nobody asked for into the record a dispute is settled from.
  `disposed_at` comes from that handoff's own instant, so a review typed up a week later is
  dated when it happened, and a later handoff moves the ball again while the disposition
  stands.
- The disposition is **text with a CHECK** naming the five, byte-exact: `Approved`,
  `Approved as Noted`, `Revise and Resubmit`, `Rejected`, `For Record Only`. Never a database
  enum — ADR-0031's reason, three of the five being un-nameable as Prisma enum members — and
  refused at the boundary by the body schema's `enum` as well. Only a submittal has one,
  enforced **at the boundary only**, as the question rule is: the kind lives on `registers`
  and a CHECK cannot read another row. Recorded once; a second is refused rather than
  overwriting the outcome of a review.
- The turnaround target is `turnaround_days`, an **integer duration and never a date**
  (ADR-0037). The glossary strikes *due date* under RFI, and the day a review falls due is a
  function of this number and of when the ball reached us, which the history already holds.
  Set once and a second is refused: moving a target moves which entries *were* past their
  clock, backwards through every day the number was different, and the daily layer is only
  worth trusting if it cannot be made to have said something else.
- `GET /v1/clock` returns the **entries and not a number**, with `?projectId=` for one job —
  exposure's shape exactly, including the 404 on an unknown project and archived projects
  leaving the across-every-project list while keeping their own (ADR-0037). Sorted **longest
  in our court first**, which is what "oldest first" means for a record whose age is the time
  it has spent with us, and not furthest past its target, which would reorder a 7-day RFI
  above a 14-day submittal that has been here nine days longer; `created_at` breaks a tie. The
  filter runs in the application, not in a `where` clause, because the sum has an open last
  interval — the one view here whose predicate cannot be pushed into the database.
- A next round is `register_entries.previous_round_id`, unique, written by
  `POST /v1/register-entries/:id/next-round` (ADR-0037) — ADR-0028's `supersedes_id` arriving
  for a second record, with nothing written to the round it follows and `nextRoundId` on the
  wire so a screen can link forward. Submittals only. It is **not** narrowed to a Revise and
  Resubmit and requires no disposition at all: the screen offers it on that disposition, which
  is the whole of story 77, but a transmittal log is written up out of order (ADR-0036) and
  requiring the review first would refuse a legitimate backfill. The successor **inherits
  nothing** — its own clock from its own first handoff, its own target — deliberately
  departing from ADR-0028's carry-forward, because carrying a contractual term forward would
  assert a number nobody typed. The form offers the previous round's value as a default, which
  is where a convenience belongs.
- `apps/web` imports carry no file extension (bundler resolution); `apps/api` imports carry `.js` (NodeNext). `tsc` accepts the wrong one and the bundler does not.

## Agent skills

### Issue tracker

GitHub Issues via the `gh` CLI, account `augustov58`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context, but the glossary and ADRs live in the Obsidian vault, not under `docs/adr/` here. See `docs/agents/domain.md`.
