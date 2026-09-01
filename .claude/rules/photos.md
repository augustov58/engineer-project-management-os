---
paths:
  - "apps/api/src/routes/photos.ts"
  - "apps/api/src/object-store.ts"
  - "apps/api/test/photos.test.ts"
  - "apps/api/prisma/schema.prisma"
  - "apps/web/app/photo-form.tsx"
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
