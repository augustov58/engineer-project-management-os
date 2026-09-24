---
paths:
  - "apps/api/src/routes/photos.ts"
  - "apps/api/src/object-store.ts"
  - "apps/api/test/photos.test.ts"
  - "apps/api/prisma/schema.prisma"
  - "apps/web/app/photo-form.tsx"
  - "apps/web/app/photo-evidence.ts"
  - "apps/web/app/evidence.tsx"
  - "apps/web/app/photos/**"
  - "apps/web/app/wall-clock.ts"
  - "apps/web/app/site-visits/*/page.tsx"
  - "apps/web/app/projects/*/page.tsx"
---
# Photographs, binning and the filename grammar

Ground rules moved out of `AGENTS.md` on 2026-09-01, none rewritten. Claude Code loads this file when a
path in the frontmatter is read through the Read tool; from the shell, read it yourself. The rules that
apply to every path stay in `AGENTS.md`.

- A photograph's bytes go to the injected `ObjectStore` port and never into the database
  (ADR-0032). The row keeps `storage_key` and that key never reaches the wire. The bytes are
  read back through `GET /v1/photos/:id/bytes` and **not** a presigned URL: that would be a
  second thing reachable without the edge gate ADR-0020 carved its one exception out of.
  `apps/web` proxies the route so the browser never calls the API. (0020 read *still
  Proposed* here until issue #84; it was Accepted 2026-09-01 and built as slice 21.)
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
- **Nothing back-fills** (issue #138, dated lines on ADR-0032 and ADR-0056). The grammar
  resolves against the findings that exist when the photograph is added, so one named
  `issue-7` before Issue 7 is raised stays unbound, and raising it later reads no photograph.
  A back-fill would be a second writer of a stamped column and would move a photograph the
  engineer may already have corrected by hand. The ordinary path — bind it to the
  observation, then promote — reaches the report with no filename at all. Do not add a write
  to `photos` in the promotion transaction; every writer of `photos` is in `routes/photos.ts`.
- `photos.taken_at` is **required** and never falls back to the `TimeSource`, unlike
  `observations.observed_at` — that fallback would bin a timestamp-less photograph to
  whichever floor was being walked at the moment of the request (ADR-0032). Nothing reads
  EXIF. The screen sends the file's instant **as the file carries it** — since ADR-0054
  (issue #104), which supersedes ADR-0050 on the trigger 0050 itself named. `asTypedInstant`
  used to shift it into the typed frame so it would bin against typed windows; that is what
  made a floor window started by the *blank-time* path — stamped, so never in the typed
  frame — bin every photograph on that floor to nothing, silently (issue #97). Both helpers
  changed in one commit, as ADR-0050 required: `composeInstant` composes in the project's
  zone and `asTypedInstant` is deleted. `binToFloor` did not change and is now correct,
  because both sides of the comparison are instants.
- A photograph evidences **at most one** of an observation and a finding, beside the floor
  it landed on (ADR-0056, issue #113). `photos.observation_id` sits beside `issue_id` under
  the CHECK `num_nonnulls(observation_id, issue_id) <= 1`; there is still **no
  `photo_observations` join**, because a photograph evidences one thing. ADR-0032 refused
  this for one reason — *"there is no third mechanism that would bind a photograph to one
  observation out of the dozen made on a floor"* — and the very next slice built one,
  `voice_captures.observation_id` — `turns.observation_id` since issue #114. Binding is
  **by hand** from the observation's screen and
  there is no observation grammar in a filename: an observation has no identifier, and none
  is invented. Binding by filename still creates no **sighting** — a sighting is an
  observation.
- **Each of the two evidence routes clears the other**, which is what makes moving a
  photograph between an observation and a finding one action rather than an unbind and a
  bind (ADR-0025's bar). The CHECK is therefore unreachable from the boundary, which is the
  point of having it: the record refuses what no route should ever send. On the screen they
  are **one** select and not two, ADR-0030's reason for making Side and Sector one control —
  two independent controls would present as independent a pair the record will not let
  disagree. `apps/web/app/photo-evidence.ts` is the one place that format is spelled, in a
  plain module because a `'use server'` file cannot import out of a `'use client'` one.
- **A finding's evidence is derived** and this is the one amendment to *stamped, never
  derived* (ADR-0056): the photographs stamped to it, union the photographs of its
  sightings. **Promotion writes nothing to a photograph.** Two readers take that union —
  `withSightings` in `wire.ts`, across every walk, and `evidenceFor` in `report.ts`,
  narrowed to one — and they are deliberately not shared, being narrowed differently; the
  rule they keep in step is ADR-0056's. Since issue #119 the union is what the report
  **prints** and no longer how it **groups**: a photograph its sighting carries prints inside
  that sighting, one stamped to the finding prints under the finding, and `evidenceFor` is what
  says which bytes to inline. Membership and the order within each half are unchanged, so the
  API's answer and the issued document still name the same photographs. Neither deduplicates, because the CHECK makes the
  two halves disjoint. `GET /v1/site-visits/:id/issues-without-photos` reads **both** halves:
  the stamped clause alone sends the engineer back for a picture they already took.
- A photograph and the observation it evidences are on the **same walk**, refused at the
  boundary with a 404 naming the walk — July's photograph does not evidence August's
  observation, the narrowing ADR-0035 already gives the report. There is no `where` on the
  observation's photographs anywhere, because that refusal is what makes one unnecessary.
- **A floor-only photograph is unfiled and prints nowhere** (ADR-0056). Each floor's row in
  the report's schedule prints its count of unfiled photographs, rendering a zero
  (ADR-0038's reasoning); photographs that binned to **no** floor, and those on a floor
  nobody formally started, are counted in one line under the table — ADR-0056 has no row for
  them, and a count nobody can see is the silence it is against. The non-issue table's
  Evidence column is the opposite answer and printed only when something is in it: a column
  of blanks under that heading, in a document issued under the author's name, reads as
  evidence that went missing.
- Nothing rewrites a photograph's filename: the name is the mechanism, so a correction
  touches only the bindings. `PATCH` and `PUT` on one are 404, as they are for a submission
  and an issue, and a test asserts it.
- **A photograph added in error is removed while its walk is open** (issue #65, ADR-0066) —
  `DELETE /v1/photos/:id`, the only route that takes a record's content off the record. Past
  the walk's end it is a **409**: an ended walk is the one whose report goes out. A report
  rendered *during* the walk keeps what it printed, as every rendering does (ADR-0035). The row goes with an
  audit line that **carries what the row said** (name, floor, what it evidenced, when taken,
  which walk), by a compare-and-set on the walk still being open; the **bytes go after**,
  outside the transaction — ADR-0032's order reversed for the reverse act, so a failure leaves
  garbage and never a row pointing at nothing. Nothing cascades: nothing points *at* a
  photograph. On the screen it is *Remove*, behind a closed disclosure — *delete* is struck
  under **Archived**. **A document added in error is not answered by this** (ADR-0039's twin).
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
- On the screen, **both binding selects are 44 px** and neither has a confirm button beside it
  (issue #118, density rule 6, plate F-04). The evidence select is the control **bar 3
  actually measures** and it was `h-8`, 32 px, at the baseline; the floor select is beside it
  and stays its own, for the reason above. `fieldSelectClassName` is the styling, not
  `selectClassName` — see `.claude/rules/web.md` for why there are two.
- **One rendering of an observation's evidence**, `apps/web/app/evidence.tsx`, and one
  `isUnfiled` predicate beside it. The walk screen and the conversation panel both show it —
  under the observation, and under the capture it was confirmed from — and writing them
  separately is how one of them came to print the filenames and the other not. The filenames
  are not decoration: the name is the mechanism, and it is the one fact a thumbnail cannot
  show.
- **Unfiled is a count and not a column of blanks**, said once under the list and rendered at
  zero (ADR-0038's reasoning): a figure that vanished when it reached nought would read as one
  that had not loaded, and the report's Evidence column is the opposite answer for the
  opposite reason. The per-floor counts are in the Floors table above it.
