---
paths:
  - "apps/api/src/routes/conversations.ts"
  - "apps/api/src/routes/assumption-records.ts"
  - "apps/api/src/transcription.ts"
  - "apps/api/src/agent.ts"
  - "apps/api/src/worker.ts"
  - "apps/api/test/conversations.test.ts"
  - "apps/api/prisma/schema.prisma"
  - "apps/web/app/conversation.tsx"
  - "apps/web/app/conversation-panel.tsx"
  - "apps/web/app/recordings.ts"
  - "apps/web/app/turns/**"
  - "apps/web/app/site-visits/*/conversation/**"
  - "apps/web/app/site-visits/*/page.tsx"
  - "apps/web/app/conversations/**"
  - "apps/web/app/projects/*/page.tsx"
  - "apps/web/app/wall-clock.ts"
---
# The conversation on a walk: captures, transcription, and the draft the agent proposes

Was `voice.md` until 2026-09-16, when issue #114 made the conversation a record and
`voice_captures` became `turns` (ADR-0057 as amended by ADR-0058). Every bullet that predates
that change says *capture* where it said *voice capture*, and nothing else in it was
rewritten. Ground rules moved out of `AGENTS.md` on 2026-09-01. Claude Code loads this file
when a path in the frontmatter is read through the Read tool; from the shell, read it
yourself. The rules that apply to every path stay in `AGENTS.md`.

- A **capture** is the draft, and a draft is never a state of an observation
  (ADR-0034). `observations` gains no `draft` column and no status: confirming writes an
  ordinary observation and stamps `turns.observation_id`, which is the shape
  ADR-0031 gave promotion, and the exact-key-set test ADR-0030 built stays true.
- A capture's `transcript` is what the vendor heard — or what the engineer typed
  (ADR-0057) — and **nothing rewrites it**. The
  engineer's correction is the body of the commit call and becomes `observations.observed`;
  both facts are kept, which is what makes "transcription error never became record error"
  checkable. Nothing parses a transcript — no field extracted, no floor guessed, no location
  inferred — the posture ADR-0029 took toward a calculation's output and ADR-0032 toward
  EXIF.
- A capture's state is **four stamps** derived on read — `transcribing_since`, `transcript`
  + `transcribed_at`, `failed_at` + `failure` — and there is no status column beside them,
  for ADR-0024's reason and ADR-0031's. Retrying clears the failure, as reopening an issue
  clears its close.
- `turns.recorded_at` is required on every capture and never falls back to the `TimeSource`, as
  `photos.taken_at` is and `observations.observed_at` is not: a recording sent when the
  signal returned would be stamped with the moment it arrived. **The observation is dated
  from it**, so reviewing a walk in the evening does not date the afternoon to the evening.
- A resend carrying the same `captureKey` is answered **200 with the existing row**, not
  refused (ADR-0034), and **that holds for a typed capture too** (ADR-0057): a tap that did
  not visibly land is retapped, and a conversation is not a place to say the same thing
  twice by accident. The key is unique per **conversation** since issue #114, which is the
  same scope the walk was. This is a deliberate departure from the photograph's duplicate-filename
  409: a refusal cannot tell the phone whether the first attempt landed, and story 112 is
  about not losing a recording. The phone holds the audio until the API answers.
- "Leaves the audio recoverable" is three things and the third is load-bearing: the bytes
  stay in the store and are served through the API, `POST /v1/turns/:id/retry`
  queues it again, and **a failed capture can still be committed** — a vendor that never
  answered must not stop the walk being written up.
- Progress is the **state** over SSE, never a percentage (ADR-0034). The stream polls
  PostgreSQL and pushes the whole list; Redis pub/sub and BullMQ events were both refused as
  a second transport for a fact that lives in one table. The route uses `reply.hijack()` and
  no Fastify plugin, so ADR-0023's single `register` call stays the only place a prefix
  could be added. The machinery is `stream.ts` since slice 12 and a walk's reports open a
  stream through the same function (ADR-0035); what a record supplies is the reader.
- The transcription vendor sits behind a `Transcriber` port, and since issue #109 an adapter
  **is** written: **Azure AI Speech fast transcription** (ADR-0061), selected by
  `TRANSCRIBER=azure` with `AZURE_SPEECH_ENDPOINT` and `AZURE_SPEECH_KEY`. `transcribe` is
  **one** call — the audio goes up as `multipart/form-data` and the words come back in the
  same response — because there is no object storage here and Azure's *batch* speech API
  reads only from a blob URL. Do not reach for batch. The default still refuses and says so,
  and **an unrecognised vendor name falls through to the refusing default rather than
  guessing**; `TRANSCRIBER=stub` returns one fixed self-describing line so the review screen
  can be exercised, is off by default, and must never be set on a real walk.
- **Silence is not a failure.** A recording the vendor heard nothing in transcribes to the
  empty string and the capture reads as *transcribed*; stamping `failed_at` there would hide
  a recording the vendor answered perfectly well. The adapter is bounded at two minutes
  against the OCR adapter's five, that call being synchronous — the bound catches a vendor
  that stopped answering, not one doing long work.
- `observationBodySchema` and `observationData` are exported from `routes/site-visits.ts`
  and used by both writers of that table. ADR-0030 predicted this route and named the risk;
  do not restate the one-axis schema in `routes/conversations.ts` — the **proposal**'s body
  schema is built from that one too, `observedAt` dropped and the sighting added.
- `getUserMedia` needs a secure context, so recording does not work on a phone over
  `http://<address>:3000`. The screen says so; the fix is TLS or a tunnel, not code.

## The conversation, and the draft the agent proposes (issue #114, ADR-0058)

- A **conversation** is a record: one per site visit, created **in the same statement as the
  visit**, and any number per project. `conversations.site_visit_id` is nullable and unique,
  which is the whole of "exactly one per visit" — a guard a create route could forget is not
  what holds it. **Both contexts are built since issue #121**: a project's is opened by
  `POST /v1/projects/:id/conversations` and read by its own id, where a walk's is created
  with the walk and read through it, because what a caller has in hand differs and the
  record does not.
- `turns` is `voice_captures` renamed and widened, and it keeps **every** row's id: a
  photograph or an audit line that already points at what one became still points at it.
  `site_visit_id` is **gone** — the conversation carries the walk, and keeping both would be
  two places the same fact lives.
- A conversation reads in **`position` order and no longer by `recorded_at`**, which is the
  one ordering this slice changed. A list of recordings reads best in the order they were
  made; a conversation does not, because the agent's reply has to follow the capture it
  answers — and a recording held in a basement and sent later would otherwise jump above a
  reply to something said after it. `position` is taken under `pg_advisory_xact_lock` on the
  conversation, `routes/phases.ts`' shape and for its reason.
- **One table with columns null by role** (ADR-0043's precedent), and the roles are held by
  CHECKs rather than by the routes: an engineer's turn has a kind, a key and an instant and
  no run; an agent's turn has a run and may propose; only an engineer's may carry
  `observation_id`. *The agent never writes an observation* is true underneath as well as at
  the boundary, where the confirm route refuses an agent turn by name.
- The typed box **holds the words and the key across a failed send**: the box is cleared only
  once `added` has risen, and `captureKey` is minted on the client with
  `crypto.getRandomValues` and kept until then. Clearing on submit and minting per call each
  looked harmless and together made a lost *response* into a second turn saying what the first
  already said — the rule held by `(conversation_id, capture_key)` was true and unreachable
  from the screen. Not `crypto.randomUUID`: it needs a secure context, and the typed path is
  the one that has to work on a phone over plain HTTP.
- A **typed** capture queues a proposal run; a recording queues a transcription and nothing
  else. That asymmetry is ADR-0057's and not an oversight: a recording is a draft the
  engineer corrects, and the voice path is left exactly as it was.
- The run is an **`agent_runs` row** (ADR-0058), not a third run record — which is what keeps
  `sessions_one_run` and `audit_entries_one_run` untouched. It names the conversation it is a
  turn on, and **`MEMORY_RUNS` in `routes/memory.ts` narrows on that column being null**.
  That link is the answer to ADR-0043's reason for not reusing the table, and it is a link
  and not the `kind` column ADR-0040 refused. Both readers of the memory screen go through
  that one constant.
- The run reads the **conversation as it stands when it runs**, assembled by the worker and
  never carried on the job — which is what lets the engineer's answer to the agent's question
  reach the next run. A turn with no words is a proposal of fields and is not read back to
  the agent as though it had been said.
- The walk run's tools are **three and one of them writes**: `site_visits_get_floors`,
  `issues_list`, `capture_propose`. The floors tool **projects** the walk's read to its
  schedule, `projects_get`'s shape and for its reason — handing the response through would
  give the run its own transcript back as context. A test asserts the list exactly.
- The transcript reaches the model as **delimited untrusted data** under
  `CAPTURE_DIRECTIVE`, which is ADR-0043's directive with the noun changed. Two sentences
  saying the same thing differently would be two rules to keep in step.
- A **proposal's location is composed by the API**, through the same `renderLocation` an
  observation's is (ADR-0030). The screen spelling it itself printed `Floor 3 — South stair,
  A` against the record's `Side A` — the exact drift that ADR keeps one renderer against.
  What the engineer edits is the **fields**, seeded into the form and never fixed there.
- The conversation carries **its runs' state** and not their stamps, and *reading* on the
  panel is read from that — never from the absence of a reply. A run that failed leaves no
  turn, so a panel counting unanswered captures said the agent was still reading one forever.
  That was found in a browser, not by a type.
- **A project turn is not a capture** (issue #121). `turns_engineer_captures` takes the
  capture machinery whole or not at all — a kind and an instant together or neither, and a
  turn with neither must have its words, because no vendor is coming with them. The
  **key stays required** on both: a capture key is not about audio, it is how a send that did
  not visibly land is retried without saying the same thing twice, and a desk on a bad
  connection is not different from a phone in a basement. `transcriptionState` therefore reads
  `kind !== 'VOICE'` and no longer `kind === 'TYPED'`: only a recording is ever waiting on a
  vendor, and *queued* was a state an agent turn could never leave.
- The chat run's tools are **thirteen and one of them writes** (ADR-0058 part 4): the memory
  run's eight reads, `documents_list`, every helper route, and `assumption_record_propose`.
  The reads are `projectReadTools` and **not a copy of them** — *every read the memory agent
  has* is a sentence about one list, so a ninth added there reaches the chat without anybody
  remembering. That is as far as part 4's *"both tool lists are generated from one registry"*
  is taken: the walk's three stay written out, its `issues_list` carrying a different
  description, and sharing the entry would rewrite a built run's prompt surface. A test
  asserts each list exactly and that they differ.
- The conversation reaches the chat run under `CHAT_DIRECTIVE`, which is a **third** sentence
  and not a generalisation: changing `CAPTURE_DIRECTIVE`'s noun would rewrite the prompt a
  built run is already given. All three are `EXTRACTION_DIRECTIVE`'s wording with the noun
  changed, so they stay one rule said three times.
- **The chat's one write is a proposal and the confirm is the existing route.** The agent
  turn carries `proposed_submission_id` and the two blocks verbatim; confirming is
  `POST /v1/submissions/:id/assumption-records` with `turnId` in the body, so there is one
  writer of `assumption_records` and one place its caps, refusals and audit line are spelled.
  `assumption_records.turn_id` is **unique**, which is the whole of "one proposal, at most one
  record" — a second confirm is a 409 the database holds, not a guard. *Confirmed* is that row
  existing, which is `turns.observation_id`'s shape pointing the other way, and the panel
  withholds the form on the strength of it.
- **Asking a helper and recording what it said stay two acts** (ADR-0053). A calculation with
  no submission named is answered in words carrying the two blocks verbatim and writes nothing,
  and the reply says which submission it needs. Nothing between the tool and the column trims,
  normalises or re-wraps a block.
- The **blocks reach the record through the model**, which is the one thing no boundary can
  hold: the run reads them from `POST /v1/tools/:name` and types them into the proposal. What
  *is* held is that nothing of ours touches them on the way, and a test drives a run that asks
  the real helper and asserts the turn's blocks are byte-for-byte what it printed.
- **The tools route strips the two header lines** and a hand-typed capture usually keeps them,
  so a record captured through the chat numbers its lines one lower than the same calculation
  pasted in. Each record is self-describing — `assumptionLines` is derived from its own text —
  so nothing cross-reads them; do not "fix" it by adding a header, which would be this product
  writing a line the helper did not print.
- A proposed sighting is **proposed and never promoted**: a sighting burns an identifier that
  is never given back (ADR-0031), so it stays the engineer's second act under the observation.
  An id naming a finding on another job is a 404 at the route, not a foreign-key 500.

## The panel, redesigned (issue #118, ADR-0059 point 3)

- The panel is **one component**, `apps/web/app/conversation-panel.tsx`, lifted out of the
  847-line walk screen because ADR-0058 needs it on two records and ADR-0059 point 2 put the
  component in the design brief rather than in either ADR's ticket. **Both are wired since
  issue #121**, and almost all of the difference turned out to be **data rather than props**:
  a project turn has no `kind`, so it renders no audio control, no capture state and no *Ask
  again*, and an agent turn carries one proposal shape or the other, so which commit sits
  under it is read off the turn. What is genuinely the caller's is the live summary, whose
  words differ (a walk counts captures and transcriptions; a project has no vendor), the bar's
  copy and its one hint, and **one optional `walk` object** carrying the five things only a
  walk has — the visit's id, the two evidence maps, `add`, `commit`, `retry` and
  `bindEvidence`. `walk === undefined` is the whole of *this is a project's conversation*;
  there is no second flag beside it, and the project record passes no inert value to satisfy a
  shape it has no part in. A server component: every live part of it is already its own client
  island, and the turns have to be in the server's first paint (ADR-0028).
- The confirm form's field ids are keyed on the **turn** and never on the submission. Two
  proposals against one issuance — an ordinary second ask — put four duplicated ids on the
  page, and every label then focuses the first form's field. That is the pre-existing
  `id="party"` defect on a register entry, and it is not worth having twice.
- **The project bar is typed only**, which is plate D-02 and the record rather than the
  drawing: a project conversation has no capture machinery and nothing transcribes for it, so
  a microphone there would be a control with no route behind it. Plate F-03's *"one capture bar
  holding spoken and typed"* is the walk's.
- **While a record is still proposed, the form is the reading.** The blocks are shown
  read-only only once the proposal has been captured. Printing twenty-five lines of a sizer's
  output twice — once to read and once to edit — was 600 px of the same text on a 390 px
  screen and read as two different things.
- `useLiveList` treats the **empty path as no stream** (issue #121). The project panel is on
  the page before a conversation exists, and `new EventSource('')` resolves to the page's own
  URL and would poll the document forever.
- **The commit sits under the agent turn that proposed it**, which is the brief's anatomy and
  a change from where it was. What it writes is still the *engineer's* capture — the confirm
  route refuses an agent turn by name — so the form is rendered under the answer and bound to
  the turn above it. Where there is no answer, the spoken path and a run that failed alike,
  it stays under the capture: a failed capture is still committable, and that is what stops a
  dead vendor stopping the walk being written up.
- **Record, and type, are one bar** at the foot of the panel. They were a card with a rule
  across it; spoken and typed are one record (ADR-0057) and the bar says so by being one
  control group. The two static sentences under the two controls became **one** hint under
  the bar, for the same reason — two copies of *the agent proposes, your confirm records* said
  it twice. What is left under the recorder is the state that is not static: what this device
  is still holding, and only when it is holding something.
- A turn's words are the **Record** step, 16/24 (`text-base`), and the box that types one
  carries `md:text-base` — the Textarea's own default drops to 14 px at a desk, and a turn is
  the record and not the chrome around it.
