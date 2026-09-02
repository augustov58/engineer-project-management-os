---
paths:
  - "apps/api/src/routes/ingest.ts"
  - "apps/api/src/routes/extractions.ts"
  - "apps/api/src/routes/documents.ts"
  - "apps/api/src/routes/projects.ts"
  - "apps/api/src/inbound-mail.ts"
  - "apps/api/src/ocr.ts"
  - "apps/api/src/worker.ts"
  - "apps/api/src/agent.ts"
  - "apps/api/test/ingest.test.ts"
  - "apps/api/test/extractions.test.ts"
  - "apps/api/test/documents.test.ts"
  - "apps/api/test/projects.test.ts"
  - "apps/api/prisma/schema.prisma"
  - "apps/web/app/ingest.tsx"
  - "apps/web/app/ingest-form.tsx"
  - "apps/web/app/extractions.tsx"
  - "apps/web/app/documents.tsx"
  - "apps/web/app/document-form.tsx"
  - "apps/web/app/document-versions/**"
  - "apps/web/app/ingested-document-files/**"
  - "apps/web/app/processing-location.tsx"
  - "apps/web/app/projects/*/extractions/**"
  - "apps/web/app/projects/*/page.tsx"
---
# The ingest address, documents and referenced files, extraction and the processing location

Ground rules moved out of `AGENTS.md` on 2026-09-01, none rewritten. Claude Code loads this file when a
path in the frontmatter is read through the Read tool; from the shell, read it yourself. The rules that
apply to every path stay in `AGENTS.md`.

- A **referenced file** is a document stored and linked but deliberately **not** parsed, and
  it is a **column** on `documents` and never the sketch's third `referenced_files` table
  (ADR-0039). The glossary defines one as *a document*, so a second table would make one
  document two records and give "is this one?" two answers free to differ. `referenced_file`
  is **required in the create body with no default** — a default classifies by omission and
  the omitted answer is the dangerous one, since an unclassified 86-sheet set would be
  something extraction may be pointed at.
- `POST /v1/documents/:id/referenced-file` marks one after the fact and runs **one way**:
  it sets the column true and there is no route that sets it false (ADR-0039). The criterion's
  verb is *mark*, so it is an action and not only an answer given at entry; being one-way is
  its safety — a correction may always take a document out of extraction's reach and may
  never put one into it. A second marking is refused, as a response and a disposition are.
  This is the only column on a document anything writes after it is recorded; nothing else
  edits one and nothing deletes one.
- The base64 body pattern for a document version is **whole quartets** —
  `^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$` — and not the
  `^[A-Za-z0-9+/]+={0,2}$` a photograph and a recording use. That looser one admits a length
  of 4n+1, which `Buffer.from` **silently truncates** rather than refusing, so a short file
  would store and the route would answer 201 (ADR-0039). `routes/photos.ts` and
  `routes/voice.ts` carried the loose pattern and the same latent truncation until
  2026-09-02, when the change about those records ADR-0039 said it would take was made
  (issue #54): all three now spell the strict pattern, and each of the three has a test
  sending a whole quartet plus one character and expecting a 400.
- `documents` is the **identity** — the title and the referenced-file answer, no bytes and no
  state — and `document_versions` holds the file. Deliberately not ADR-0028's one-table
  chain: two links of a supersede chain share nothing, two versions of a drawing set share
  their whole identity, and on a chain the title and `referenced_file` would be copied onto
  every row and free to disagree. `documents` is to a version's `revision` what a `Register`
  is to an entry's `number` (ADR-0036) — the scope it is unique within.
- `document_versions.revision` is the designation printed on the sheet — ADR-0008's extracted
  field of that name, entered by hand, which that ADR names as the path a failed extraction
  degrades to. The engineer's and never allocated, as a register entry's number is.
  **`@@unique([documentId, revision])` is the whole of "a new version never overwrites a
  prior one"** — the database holds it, not a guard. `PATCH`, `PUT` and `DELETE` on a
  document or a version are 404 and a test asserts it.
- "Light metadata" is the title and the referenced-file answer and nothing else. ADR-0008's
  other five — document number, date, discipline, document type — are extraction's to
  produce; a column nothing writes is a column nobody can trust (ADR-0039).
- What a submission's sheet list points at is a **document version**, through
  `submission_document_versions` written **after** the issuance (ADR-0039). It is not a link
  to *one sheet*: ADR-0026 and the glossary both price that as a migration off the
  `sheet_list` text column, and nothing in issue #17 addresses a single sheet, so that
  migration is still priced rather than taken. A column on `submissions` is impossible — no
  route updates one — which is why ADR-0036 put `submission_id` on the register entry.
  `register_entry_document_versions` is the same shape. The link is **not** narrowed to a
  referenced file, for the reason ADR-0037 did not narrow a next round to a Revise and
  Resubmit.
- `GET /v1/projects/:id/extraction-targets` returns the documents that are **not** referenced
  files. There is no extraction queue — no job name, no worker branch — so this read is what
  makes "a referenced file is never enqueued" checkable rather than vacuous, and it is the
  one predicate step 5's enqueuer must read (ADR-0039). Project-scoped and deliberately not
  offered across every job: a third across-every-project figure is what ADR-0016 keeps out.
- **Issue #17 is outside the employer-consent gate** and the vault's ADR README and PRD now
  say so. The gate exists because document *content* would transit a third-party OCR API;
  nothing in this slice reads a document's contents. Do not read that narrowing as covering
  the ingest address, extraction or the confirmation screen.
- A document version's bytes go to the `ObjectStore` port under `documents/<uuid>`, written
  **before** the row and never inside a transaction with it (ADR-0032's order). `storage_key`
  is NOT NULL — no queue sits between the row and the file — and never reaches the wire. The
  content type is a closed set of **three** (PDF, Word, Excel), refused by the body schema
  and by a CHECK. Base64 in the JSON body, capped at 48 MiB of file against a photograph's
  12; a **scanned** large-format set can exceed that and is the case that would move the
  boundary to a streamed body. `apps/web` proxies the bytes with `encodeURIComponent`.
- Nothing is named so as to read as the glossary's **Document register**, whose overlap with
  **Register** was flagged as drift on 2026-08-24 and is still unresolved. Slice 13 dodged it
  and slice 16 dodges it too.
- The **ingest address** is a high-entropy token on `projects`, composed with `INGEST_DOMAIN`
  on read and **null** where none is configured — never a plausible address that receives
  nothing (ADR-0042). Never ADR-0009's `rfi+{project-key}@...`: that phrase is struck by the
  glossary and an address built from `T-1` is guessable off a document header. The token
  never reaches the wire alone; `projectOnTheWire` swaps it for `ingestAddress` the way it
  strips `issuesAllocated`. Not rotatable — a recorded gap, not an oversight.
- The `InboundMailProvider` port has **no adapter written** and that is load-bearing: it is
  what keeps the employer-consent gate, since nothing leaves the process until somebody
  writes one. The default refuses; `INBOUND_MAIL=stub` reads one documented normalised
  envelope and must never be pointed at a real mailbox. `configured` is on the interface
  because the route must tell a deployment fact (503) from a payload fact (400) — a
  `Transcriber` needs no such flag, since its refusal lands on a row that already exists.
- An **ingested document is not a `Document`** (ADR-0042). `referenced_file` is required with
  no default, and `revision` and the title are the engineer's and never allocated, so an
  arrival cannot be one without inventing all three — which is exactly what ADR-0039 refused.
  Extraction proposes them and the engineer confirms, in issue #20. The files it carries are
  `ingested_document_files` and are **never called attachments**: that word is struck by three
  of the glossary's `_Avoid_` lists.
- An arrival's `content_type` is **free text**, deliberately not ADR-0039's closed three:
  refusing a `.dwg` would lose the record the manual fallback exists to protect. The
  served-under-our-origin hole that opens is closed at the read instead —
  `GET /v1/ingested-document-files/:id/bytes` answers `application/octet-stream` **always**,
  with `nosniff` and a disposition, and never echoes the sender's claim into a header. A
  document version's route still hands its own type back, and may, because that set is closed.
- `ingested_documents.arrived_at` is stamped from the `TimeSource` and the sender's `Date`
  header is **not read** — the opposite answer to `photos.taken_at` and
  `voice_captures.recorded_at`, because the only value on offer here is one an untrusted
  party controls (ADR-0042).
- The **rate limit is a count of `EMAIL` rows in the trailing hour**, not a counter beside
  them — exposure's and the clock's shape. No Redis key: a counter in a second store is a
  second place the number lives, with its own expiry and its own answer to being empty. It
  lives in `routes/ingest.ts` and not a Fastify hook, because ADR-0033 keeps `server.ts` the
  boundary and nothing else. **Manual entry is never limited**, being the fallback that must
  not be blocked.
- That count runs **twice and both matter** (ADR-0042). Counting then inserting is two
  statements, so one check is not a bound: a burst all reads the same number and all passes.
  The cheap read refuses a flood *before* its bytes are stored; the second runs inside a
  transaction holding `pg_advisory_xact_lock` on the project and is what makes the limit a
  bound. A test fires twenty at once and fails without the lock. Do not collapse them back
  into one, and do not move the object-store write inside that transaction (ADR-0032).
- **The address is resolved before the files are checked.** A stranger posting to an address
  that names nothing must not be able to make the route walk a regular expression over
  megabytes of base64 they chose. A malformed address and one that names no job get the
  **same 404** — an address is a credential, and distinguishing them would say when the shape
  had been guessed.
- **Nothing on this route answers with a thrown message.** The 400 and the 500 are fixed
  sentences: Fastify's default 500 body is `{ message: err.message }` and this product sets
  no error handler, so on the one route a stranger reaches that would hand out Prisma's or
  the object store's own text. Scoped to `routes/ingest.ts` on purpose — an error handler on
  the whole `/v1` context would change every other route's answer and is its own change.
- `content-disposition` carries **both RFC 6266 forms**. Node refuses a header value outside
  latin-1, so interpolating a sender's filename raw makes an em dash or any CJK character a
  500 and the file unreachable because of what it was called.
- `InboundMailProvider.read` takes the **headers as well as the body**, which the stub
  ignores: a real provider signs its webhooks in a header, and this is the one route where a
  signature is the only thing that could say the caller is the provider. No adapter is
  written, so that verification is a **known gap**, as is the fact that the tests exercise a
  normalised envelope of this repo's invention rather than a vendor's recorded payload.
- A sender's `subject` and `body` are **bounded and refused past the bound, never truncated**
  — a silently shortened body is a record saying something the sender did not, ADR-0039's
  base64 lesson.
- An **extraction** is one record, `register_entry_extractions`: the run's four stamps, the
  proposal's fields and the resolution, with the state derived on every read and **no status
  column** — the shape a voice capture and a site visit report established (ADR-0043). The
  source is **exactly one** of an ingested file or a document version, held by a CHECK, so
  the ambiguity is never a value in a column. The asking is **manual and per file**: the
  engineer picks which file of an arrival is the correspondence (story 84's "automatically"
  narrowed, recorded in ADR-0043).
- The extract worker's order is what keeps the consent gate: bytes, then the `OcrProvider`,
  then `ocr_text` **stored before the agent is called**, then the run — so a refusing
  default fails the row honestly and leaves what the vendor read. The OCR port's default
  refuses; `OCR=stub` returns one fixed page and is for the screen, never a real document.
  There is **no retry route**: asking again is another row, and a redelivered job re-calls
  the vendors — that re-run is the only recovery path, and the compare-and-set on finish is
  what keeps two attempts from both settling the row.
- The extraction agent's tool list is an allowlist naming `extraction_propose` and nothing
  else (0040, 0041). The packet reaches the model as delimited untrusted data under an
  explicit non-instruction directive, and the typed-shape constraint lives at the proposal
  route's **body schema**, not in the prompt — a prompt is not a place a constraint can be
  held. One run proposes at most once, and only while running.
- **Confirming is the commit, and it commits everything in one transaction** (ADR-0043):
  the document and its first version on the mail path — **reusing the arrival file's
  storage key**, the bytes already being stored — the register entry, its first handoff,
  and the join to the source version, with `confirmed_at` and `register_entry_id` stamped
  by compare-and-set so a double confirmation refuses. The register's boundary rules are
  re-stated, not bypassed: an RFI still needs a question, a submittal still carries
  neither, a number already in the register is still a conflict. **Reject keeps the source**
  exactly as it arrived and keeps the proposal on the record. `PATCH`, `PUT` and `DELETE`
  on an extraction are 404.
- The confirmation screen reviews against **what the agent read** — the OCR text and the
  envelope — and never a rendering of the file: arrival bytes are served as
  `application/octet-stream` attachments on purpose (ADR-0042), and this screen does not
  poke that hole. The bytes are one click away.
- **The processing-location default is cloud** (ADR-0044), settling the contradiction the
  vault carried as open since 2026-08-24. ADR-0008 names ADR-0013 as its qualifier and the
  glossary claimed the same role in the opposite direction, so the one 0008 points at holds;
  the glossary entry and the PRD's third formulation are corrected and 0013 is unchanged. A
  `processing_location` **database enum** on `projects` (ADR-0036's test, not ADR-0031's).
  `LOCAL` is a **permission, not a selector**: there is no local OCR and `OcrProvider` takes
  no project, so it means the port is never called and manual entry is the path. Do not
  build a two-adapter selector for one adapter.
- The sign-off gates the **switch**, not the state. Under a cloud default a project arrives
  on `CLOUD` never having been switched, so "cloud implies a sign-off" is **false by design**
  and no CHECK can hold it — the one that is written holds the pairing alone
  (`reference IS NULL = at IS NULL`), and that weakening is what the resolution cost.
  Switching to cloud requires `signoffReference` and `signoffAt` and refuses a second;
  recording the first against a default project is not a second. Switching to **local
  requires nothing and no consent fact can refuse it** — consent can be withdrawn, and that
  asymmetry keeps ADR-0039's principle while inverting its mechanism. The one refusal it
  has is the no-op, on a project already local. It **clears** the sign-off, safe
  only because the audit entry carries the reference and the date.
- `cloud_signoff_at` is **supplied and never the `TimeSource`'s** — `held_since`'s frame and
  ADR-0037's answer for `disposed_at`. When the switch happened is the audit row's
  `created_at`, which is the TimeSource's; the two are different facts and both are kept.
- The gate runs **twice and both matter** (ADR-0042's shape). Both extraction create routes
  refuse the ask before a row or a job exists; the **worker reads the setting again before
  the bytes are fetched**, and that is the bound — a job enqueued while the project was on
  cloud is already in Redis when consent is withdrawn. The setting is read on the row and
  never carried on the job. One sentence, `PROCESSING_LOCATION_IS_LOCAL` in `refusals.ts`,
  said by both. Do not collapse them into one.
- Issue #21's second criterion — "switching a project to cloud requires a recorded written
  sign-off" — is met **literally and not as an outcome**, and ADR-0044 says so rather than
  counting it met. Its force came from local being the default; under a cloud default no
  project need ever be switched, so **cloud processing with no recorded consent is the
  ordinary case**. Whoever writes the OCR adapter must read each existing project's
  location before the first run, not after.
- The **audit widens exactly once** here (ADR-0044), which is the change ADR-0043 said would
  be its own: one action, on the project's own setting, in the same transaction as the
  update. Extraction mutations still write no audit rows. Note that
  `GET /v1/projects/:id/memory/audit` has always returned the project's *whole* audit
  (`where: { projectId }`), so its path is now narrower than what it answers — recorded, not
  fixed; renaming it is a frontend change.
