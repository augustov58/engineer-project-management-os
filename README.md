# Engineer Project Management OS

Internal operations dashboard for engineering projects, with a Pi-powered copilot.

Planning documentation is authoritative in the Obsidian vault, not here — start with
[CONTEXT.md](./CONTEXT.md), which points at it.

## Requirements

Node 22.12+, pnpm 10, and Docker (PostgreSQL and Redis run in containers; nothing needs
to be installed on the host).

## Running it

```bash
pnpm install
pnpm dev
```

`pnpm dev` copies the `.env.example` files if no `.env` exists yet, starts PostgreSQL and
Redis, applies migrations, and runs both apps: API on <http://127.0.0.1:3001>, frontend on
<http://127.0.0.1:3000>.

Use `localhost`, not `127.0.0.1`, in the browser: `next dev` refuses to serve its own
`/_next/*` assets to an origin it does not recognise, so the page renders and then dies
with a 403 on every script. `apps/web/next.config.ts` adds this machine's own network
addresses to that list, which is what makes the app viewable from another device on the
same network. **Only the frontend is reachable that way** — the API, PostgreSQL and Redis
stay bound to loopback, and nothing breaks because every call to the API is made by the
Next server rather than by the browser. A client-side fetch to `NEXT_PUBLIC_API_URL` would
break that, and would only fail on the second device.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Everything: containers, migrations, API, frontend |
| `pnpm typecheck` | `tsc --noEmit` across both apps |
| `pnpm test` | API test suite — starts its own PostgreSQL and Redis, so nothing needs to be running first |
| `pnpm services:up` / `services:down` | The Docker containers on their own |
| `pnpm --filter api migrate:dev` | Create a migration after editing `schema.prisma` |

## Layout

```
apps/api    Fastify API, Prisma schema and migrations, BullMQ queue
apps/web    Next.js frontend (App Router)
docs/       Agent-facing notes; the ADRs and glossary live in the vault
```

## What earlier slices fixed, so later work does not re-decide it

- **Fastify, not NestJS** (ADR-0021). Dependencies are passed into `buildServer()` as
  arguments; nothing is resolved from a container. Both `src/index.ts` and the test
  harness get theirs from `createRuntime()` in `apps/api/src/runtime.ts`, so tests
  construct the server the way production does by construction, not by two copies of the
  wiring staying in step.
- **`TimeSource`, not `Clock`** (ADR-0022). "Clock" is domain vocabulary here — register
  entries aging in our court — so the wall-clock port is called `TimeSource`. Nothing
  persists a timestamp from `new Date()`, and no aged column carries a database default,
  because either would be unreachable by the fake. Aging is tested by advancing the fake.
- **The test harness.** `apps/api/test/harness.ts` is the pattern every later slice copies:
  an ephemeral PostgreSQL per test run migrated by `prisma migrate deploy` from the same
  migrations production uses, a fresh database copied from it per test, a real listening
  HTTP server, and fixtures built through the API rather than by inserting rows.
- **`/v1` on every route** (ADR-0023). The prefix is one `register` call in
  `apps/api/src/server.ts`, not a string repeated per route. Slice 2 moved `/health` under
  it and dropped `skeleton_records`, so nothing unversioned survives.
- **One column says whether an open item is unresolved** (ADR-0024): `resolved_at` being
  null, with `resolution_note` moving with it. Exposure, provisional state and the pending
  items view are all derived from that column, so none of them can disagree about what
  "unresolved" means. There is no status field, and adding one would create a second
  answer. The subject is polymorphic — `subject_type` is a database enum carrying only
  `PROJECT`, so attaching an open item to a submission is a migration, not a new string.

- **What an issuance rests on is a join, not a subject** (ADR-0026). An open item's
  `subject_type`/`subject_id` says where it lives; `submission_open_items` says which
  issuances depended on it. ADR-0024 expected the other reading — adding `SUBMISSION` to
  the subject enum — and taken literally it breaks the next two slices: attaching an
  existing item would re-point it off the project, and issue #7's "carry forward to the
  reissue" would re-point it off the superseded submission, erasing the record of what the
  original went out on. One item can back several issuances, and a resolved one stays on
  the set it went out with.
- **A phase is a row the submission points at** (ADR-0026), so renaming propagates to
  everything issued at it. That is deliberate: a rename is the same body of work under a
  better name, and a set that went out at a different stage is a different phase.
  **Nothing edits a submission** — the API exposes no route that updates one, which is what
  makes "no path edits an issued submission" true by construction rather than by a guard
  someone can forget. What a set rests on is named in the same call that records it,
  because issue #6 stamps whether it went out on unconfirmed inputs *at the moment of
  issuance*; a two-call flow would leave no such moment and force a rewrite of this slice.

- **Provisional is two facts and the record keeps both** (ADR-0027).
  `submissions.issued_provisional` is stamped at the moment of issuance and never
  recomputed; *currently provisional* is derived on every read from `resolved_at` and
  stored nowhere. Resolving everything a set rested on takes it out of exposure and leaves
  standing the fact that it went out on unconfirmed inputs — one column could not be both,
  because it would start lying about one of them the moment an item resolved.
  `submission_open_items.unresolved_at_issuance` is the per-item snapshot, nullable because
  the null says the item was attached *afterwards*; **detach is narrowed to exactly those
  rows**, which is how cleanup cannot erase what went out.
- **Superseded is a successor existing, not a stored flag** (ADR-0028). A reissue is a new
  submission carrying `supersedes_id`; nothing is written to the row it points at, because
  writing to it is the edit the record type exists to prevent. *Superseded* is therefore
  derived on every read — the shape ADR-0027 gave *currently provisional* — and there is no
  `superseded_at`, the successor's `issued_at` being when the prior set stopped being
  current. `supersedes_id` is **unique**, and that alone is "at most one successor; the
  chain is linear": a second reissue is refused by the database. Cycles cannot arise, since
  a row is created already pointing at an older one and nothing repoints it, which is what
  lets the chain be walked link by link and returned whole from any of them.
- **Carry-forward is the create path with one different default** (ADR-0028). On a reissue,
  `openItemIds` left off carries forward what the superseded set rested on; supplied is
  exactly that list, so `[]` is a deliberate drop rather than an omission. The successor
  stamps its own `unresolved_at_issuance` and `issued_provisional` at its own moment of
  issuance — an item answered in between reads `false` on the reissue and stays `true` on
  the ancestor — and the phase defaults to the superseded set's rather than to wherever the
  job has since got to.
- **Exposure is a list, not a number** (ADR-0027). `GET /v1/exposure` returns the
  submissions themselves, optionally narrowed by `?projectId=`, so every count on every
  screen is that list's length — "clicking the count lands on exactly what it counted" is
  then true by construction rather than by two queries agreeing. A payload that is an array
  also has nothing to combine a second figure with, which is ADR-0016's prohibition made
  structural rather than remembered. Archived projects leave the across-every-project count
  and keep their own, and superseded ancestors leave it entirely (ADR-0028) — carry-forward
  puts the same unresolved item on both, so counting the ancestor too would make the number
  grow by correcting the record.

- **A captured block is verbatim, and a line of it is an entry** (ADR-0029). An assumption
  record holds the `ASSUMPTIONS` and `FLAGS / VERIFY` blocks as two text columns containing
  exactly what was pasted — nothing trims or re-wraps them, and no route edits or deletes a
  record, so a rerun of the calculation is another record dated its own day. An entry is
  addressed by its **line number**, and every non-blank line is one: the `- ` and `! `
  sigils the three calculators print are their convention rather than a contract, and
  splitting the blocks into rows at capture would be the transcription by hand the record
  type exists to avoid. `assumptionLines` and `flagLines` are split on every read and stored
  nowhere, so the block and the things pointing into it cannot disagree.
- **A flag becomes an open item, and that item is attached after the issuance** (ADR-0029).
  `POST /v1/assumption-records/:id/flags/:line/open-item` takes the flag's own wording when
  `unresolved` is left off, lands the item on the project, and attaches it to the submission
  the record justified. Because it is attached afterwards, it makes the set *currently*
  provisional and puts it into exposure while leaving `issued_provisional` exactly as it was
  stamped — a flag raised today cannot change what a set went out on last month.
  `raised_flags.open_item_id` is unique, which is the whole of "one flag, at most one item".

- **A location is components, and the grammar is rendered** (ADR-0030). An observation
  stores `floor`, `qualifier`, and exactly one of `side` or `sector` as four columns;
  `Floor N — <qualifier>, <Side|Sector>` is composed from them on every read and stored
  nowhere, so the parts and the string cannot come to disagree. Both axes set is refused and
  so is neither — the grammar has no optional segment — at the body schema *and* by a CHECK
  constraint, because Side and Sector not combining is a property of the record rather than
  a habit of the interface, and two more routes (#10, #12) will write this table. `side`
  holds `A`, never `Side A`: the axis name belongs to the rendered segment.
- **The floor is free text, on both tables** (ADR-0030). It holds the designation without
  the word — `3`, `B1`, `M`, `PH` — because the grammar writes `Floor N` but real buildings
  have basements, mezzanines and penthouses an integer could not record. The schedule's
  floor and the observation's floor are the same type and deliberately not a foreign key:
  an observation must be recordable on a floor nobody formally started.
- **A walk exists before it is over** (ADR-0030). `site_visits.ended_at` is nullable, and
  `POST /v1/site-visits/:id/end` stamps it once, because the per-floor schedule is recorded
  *during* the visit. The date is the day of the start, derived. One row per floor per
  visit, unique on the pair, each with a start and a nullable completion — that pair is the
  window issue #11 bins a photograph's timestamp against, which is why a visit ending before
  it started and a floor completed before it was started are both refused.
- **An observation stays an observation** (ADR-0030). No status column, no category, no
  promotion route: the "Notable Observations (Non-Issues)" table is the majority case, so
  that is the default path, and becoming an **issue** is issue #10 arriving as a row that
  points at the observation. A test asserts the exact key set an observation returns, so a
  status cannot be added without a failing test saying so.
- **The glossary's `_Avoid_` lists bind column names, not just UI copy** (ADR-0030). The
  observation's content column is `observed`, not `note`, because the glossary strikes that
  word for this record — the first draft named it `note` anyway, with a comment above it
  quoting the rule it was breaking, and review caught it before it reached a deployed
  database. Check a new column name against the glossary before writing it.

- **An identifier is a high-water mark, not a count** (ADR-0031). An issue's number comes
  off `projects.issues_allocated`, read and incremented inside the transaction that writes
  the issue, so it only ever increases and a number is handed out once and never again — not
  after a close and not after a deletion, which `MAX(number) + 1` and `COUNT(*) + 1` could
  not promise, since both hand the same number out twice the moment a row goes away. The
  increment takes the project's row lock, so two promotions at once serialise rather than
  race, and the unique index on `(project_id, number)` is what actually holds "never
  renumbered". The counter never reaches the wire: every route that returns a project strips
  it, and a test asserts the exact key set each of them comes back with, because a screen
  reading it as "issues on this job" would be wrong the first time a promotion was refused.
  What a project's issues *are* is `GET /v1/projects/:id/issues`, whose length is the count
  — the shape ADR-0027 gave exposure. Nothing deletes an issue and no route renumbers one;
  `PATCH`, `PUT` and `DELETE` on one are all 404, and a test says so.
- **An issue owns no content, and the sightings are its history** (ADR-0031). No summary
  column and no location: the PRD's sketch named a `location` on the issue, but one
  re-observed on three walks has three of them, so a column would have to pick a walk and be
  silently wrong about the other two. What was seen, when and where is read through
  `issue_observations`, one row per sighting, with `observation_id` **unique** — one
  observation, at most one issue, because a double tap that promoted twice would burn an
  identifier that can never be given back. Those rows also carry "still there on the second
  walk", which is why there is no per-visit status and no transition log. Closing is
  `closed_at` plus `closure_note` moving together (ADR-0024's shape), reopening clears both,
  and a second close is refused rather than repeated.
- **An open item on a finding is a join, and its subject stays the project** (ADR-0031).
  ADR-0030 predicted story 69 would need a second value in `OpenItemSubject`; it does not.
  The pending items view resolves a subject by looking the id up in `projects`, so an item
  subjected to an issue would arrive there with no job beside it — the opposite of what the
  story asks for. `issue_open_items` says which finding an item is being chased for; the
  subject still says where it lives. Nothing in the pending items view changed to make it
  work, which is the sign the shape is right. The `category` is text with a CHECK naming the
  five rather than a database enum, because a Prisma enum member cannot be named
  `Physical / Safety` and the real words would then live in a lookup in the API and again in
  the frontend.

- **The filename grammar, written down at last** (ADR-0032). `/\b(?:issue|iss)[-_ ]?(\d+)/gi`
  — `issue` or `iss`, then the number, separated by a hyphen, an underscore, a space or
  nothing, case-insensitive. ADR-0031, the glossary and the schema's own doc comment each
  recorded, in the same words, that this was described in ADR-0018 as "already in use" and
  written down nowhere, and each refused to invent it; it was asked for and supplied.
  **A marker is required and a bare integer never counts.** Those filenames carry the floor
  as well as the finding, so `3-west stair-issue-12.jpg` opens with a bare `3` — reading any
  integer as an identifier would bind every photograph taken on floor 3 to issue 3, and a
  mechanism wrong about most of a hundred photographs is worse than one that binds none,
  because then all hundred have to be checked. One distinct number in the name or nothing.
  The floor component is deliberately not read here: the timestamp is the floor's mechanism,
  and two answers to one question is a disagreement settled by a coin.
- **Exactly one window binds, or nothing does** (ADR-0032). A floor's window runs from its
  start to its completion, both ends included, and stays open while the floor is still being
  walked. The ticket says a photograph outside every window is left unbound rather than
  guessed at; two windows containing it is the case the ticket does not mention and the
  schedule really produces, because nothing orders the floors and an engineer who starts
  floor 4 before closing floor 3 has doubled back. Picking one of two is the same guess, so
  it gets the same answer. The open-ended window is what keeps the last floor of a walk —
  the one most often left unclosed — binning correctly.
- **A binding is stamped, not derived** (ADR-0032), which breaks this product's own reflex.
  `location`, *currently provisional* and *superseded* are all computed on every read; both
  photo bindings are columns written when the photograph is added. A derived binding has
  nowhere to keep the correction story 65 asks for, and the schedule is fixed the morning
  after the walk — a derived value would silently move photographs between floors when a
  floor time was corrected. There is no provenance column: "the engineer cleared it" and "no
  window contained it" are the same stored fact, which is right.
- **`photos.taken_at` is required and never falls back to the clock** (ADR-0032), unlike
  `observations.observed_at`. That fallback would bin a timestamp-less photograph to
  whichever floor was being walked at the moment of the request, which is the guess under
  another name. Nothing reads EXIF. The screen sends the file's *local wall clock written as
  UTC*, the same frame `composeInstant` puts a typed time in — ADR-0030's timezone deferral
  is still open, and sending the true instant instead would offset every photograph of the
  afternoon out of every window. The frame is wrong the same way it was before; it is now
  consistently wrong across a whole walk, which is what keeps binning working.
- **The bytes go to a port and come back through the API** (ADR-0032). `ObjectStore` is the
  shape ADR-0022 gave `TimeSource`: a filesystem adapter for dev and tests, the
  S3-compatible one when there is somewhere to deploy to. Not a presigned URL — that is a
  second thing reachable without the single edge secret ADR-0020 puts in front of every
  route, and that ADR carved out its one exception explicitly and is still Proposed.
  `apps/web` proxies `/photos/:id/bytes` so the browser never calls the API directly.
- **Photo evidence lands on the floor and the finding, not the observation** (ADR-0032),
  correcting a promise the glossary's **Observation** entry had carried since slice 8. No
  mechanism picks one observation out of the dozen made on a floor, and the join that would
  need is the labelling by hand the ticket exists to remove. A photograph and the
  observations made on its floor are read together through the floor value — which is
  exactly why ADR-0030 made those two columns the same type and joined them by value.
  Binding by filename creates no **sighting**: a sighting is an observation.

- **Tailwind and shadcn/ui, owned in-repo** (ADR-0025). Components live in
  `apps/web/components/ui` and are edited in place rather than imported from a versioned
  package, so there is no library upgrade to absorb. Radix underneath means focus rings and
  keyboard behaviour come with the components. Seven controls stay deliberately native and
  styled by hand — the "nobody owes the next move" checkbox, the pending-items sort select,
  the submission phase select, the attach-an-open-item select (on a submission and on an
  issue), the observation's Side/Sector axis select, the category select that records an
  observation as an issue and the select that makes a sighting another sighting of a finding
  already on the register — because a styled component would change how they serialise into
  a form. `apps/web/app/native-select.ts` holds the shared styling.

Not covered by tests: the frontend. `apps/web` has no test script, so `pnpm test`
exercises the API only, and a change that breaks the page would not fail the suite. That
is deliberate — the MVP spec's test seam puts the thin browser-driven pass at step 3 (site
visit capture), on top of record-level coverage, rather than here.

**Step 3 is now three slices in (issues #9, #10 and #11) and that automated pass is still
not written.** Slices 8, 9 and 10 were each verified by driving the real pages in a browser
by hand, which found nothing the suite would have caught but is not a regression test — and
slice 9 showed what that costs. The hand pass walked the paths the ticket describes and passed;
review then found two the pass had not thought to walk, both frontend-visible: a bad issue
number in a URL rendered an error page where every other bad URL renders a 404, and a
finding closed since a walk still read as open on that walk. A written pass walks the same
paths every time, including the ones nobody feels like walking. The spec
scopes the pass to the *capture flow* — voice, one-handed operation, photo picking,
poor-signal reconciliation — which is issues #11 and #12. **Issue #11 has now landed
without it**, and it was the half of that flow with the most interaction in it: a
multi-file picker, per-file timestamps the server cannot read, and two selects that submit
on change. That was verified by hand — three photographs added at once, binding to both
mechanisms, to a floor only and to a finding only, and one re-binned from a single select
change — and none of it is a regression test. Only #12 is left to carry the pass; if it is
not written there, the seam the spec described does not exist.

Slice 4 hit the gap twice, both invisible to `pnpm test` and to `tsc`: a `<select>` whose
`defaultValue` is only applied at mount, so changing a project's current phase left the
form still showing the old one and the next set would have been recorded at the wrong
stage; and an `<li>` nested inside the `<li>` that `OpenItemEntry` already owns, which is
invalid HTML and failed hydration in the browser console. Both were found by loading the
page, not by a test.

Slice 5 paid for it a third time. The warning that a set is going out on unresolved open
items was first a counter incremented as boxes were ticked, and `key` sits on the `<form>`
while the state sat on the component around it — so recording a submission cleared the
boxes and left the warning claiming the next set carried items nobody had ticked. A code
review caught it; `pnpm typecheck` and `pnpm test` were both green throughout. It is now
read straight off the form, which also fixes the opposite drift (a reload that restores
checked boxes would have shown no warning at all).

Slice 6 paid for it a fourth time, and this one had been latent since slice 5. The warning
above is seeded into state and corrected by a ref callback on the form; a state update made
from a ref during the **hydration** commit is discarded, so the count stayed at its seed.
With nothing ticked at first paint that seed was right by luck, and a reissue — which
arrives with every carried item ticked — showed a page claiming the set rested on nothing
while two checked boxes sat in front of it. The count is now seeded from the props, so the
warning is in the server's HTML and the ref only corrects it afterwards. One trap while
looking for this class of bug: browse `http://localhost:3000`, not `127.0.0.1`, or Next's
dev-origin guard 403s the client chunks and the page renders but never hydrates at all.

The gap is real, and slice 2 hit it: `apps/web` resolves modules the bundler way while
`apps/api` uses NodeNext, so relative imports written `./api.js` typechecked clean and
then 500'd in Turbopack. **Web imports carry no file extension; API imports carry `.js`.**
Until there is a web test, run the app and load the pages before calling a frontend change
done.

Since ADR-0025 the frontend also compiles a stylesheet, which `pnpm typecheck` does not
check. `pnpm --filter web build` is the command that catches a Tailwind or PostCSS error;
it also works when `pnpm dev` will not, which on a machine that has run out of inotify
watches is the difference between verifying a change and not.
