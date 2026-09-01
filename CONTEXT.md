# Project Context: Engineer Project Management OS

*Last updated: 2026-09-01*

## What this is

This repo is the code workspace for the Engineer Project Management OS, an internal operations dashboard for engineering projects with a Pi AI copilot.

## Source of truth

All planning documentation lives in the Obsidian vault. This vault location is the single source of truth and MUST be kept current:

```
/home/augusto/Obsidian Notes/Projects/Engineer Project Management OS/
├── PRD and Architecture.md   ← requirements, architecture, milestones, backlog
├── docs/
│   ├── adr/                  ← architecture decisions 0001-0039 (check Status lines)
│   └── glossary.md           ← domain terms
```

**Update rules:**
- When a milestone is completed, update the progress section below and mark it in `PRD and Architecture.md`.
- Any plan adjustment, scope change, or new decision gets documented here AND in the vault (as an ADR if architectural).
- Do not treat this file or AGENTS.md as the plan. The vault files are authoritative.

## Key decisions (from vault ADRs)

Forty-four ADRs (0020 was Proposed until 2026-09-01 and is now Accepted, confirmed by the author and built as slice 21; 0021 and 0022 were decided while building slice 1, 0023 while building slice 2, 0024 while building slice 3, 0025 by the author after slice 3, 0026 while building slice 4, 0027 while building slice 5, 0028 while building slice 6, 0029 while building slice 7, 0030 while building slice 8, 0031 while building slice 9, 0032 while building slice 10, 0033 afterwards as its own change, 0034 while building slice 11, 0035 while building slice 12, 0036 while building slice 13, 0037 while building slice 14, 0038 while building slice 15, 0039 while building slice 16, 0040 while building slice 17, 0042 while building slice 18, 0043 while building slice 19, and 0044 while building slice 20; slice 21 wrote no new ADR, confirming 0020 instead and recording what building it settled inside that ADR; issue #42 wrote none either, recording what reviewing slice 17 found inside 0040). The 2026-08-24 grilling session overturned several 2026-08-17 decisions
that rested on a false premise. Read [[docs/adr/README]] in the vault for current status;
do not treat 0001-0011 as current without checking.

**Outcome test:** every deliverable I issue states what it rests on, with nothing sitting
in my court past its clock as the daily layer under it.

| # | Decision |
|---|----------|
| 0012 | Single-user personal tool (supersedes 0001 tenancy, 0005 auth) |
| 0013 | Cloud extraction default, local fallback (qualifies 0008) |
| 0014 | Open item is the central record |
| 0015 | Submissions first-class, may be provisional |
| 0016 | Exposure + clock replace the health score (supersedes 0007) |
| 0017 | No money model (strikes budget from 0006, 0010) |
| 0018 | Capture and extraction first, copilot later (narrows 0004) |
| 0019 | No vector search; retrieval by identity |
| 0020 | Single shared secret at the edge — **Proposed**, closes the gap between 0003 and 0012 |
| 0002 | Pi SDK behind `AgentRunService` port — required by the author |
| 0003 | Cloud-managed deployment |
| 0009 | Email forward-to-ingest |
| 0011 | Risk register: manual + agent-proposed |
| 0021 | Fastify, not NestJS — decided by slice 1, not revisited |
| 0022 | Time source is a port called `TimeSource`; `Clock` stays a domain word |
| 0023 | API routes carry a `/v1` prefix — settles the spec's "versioned prefix" against slice 1's unversioned routes |
| 0024 | An open item's `unresolved` column, `resolved_at` + `resolution_note` as the whole of resolution, and `subject_type` as a one-value enum |
| 0025 | The interface is designed, not incidental — Tailwind + shadcn/ui, owned in-repo; the site visit report is a separate print problem |
| 0026 | What a submission rests on is a join table, not a second subject on the open item; a phase is a row the submission points at, and renaming it propagates |
| 0027 | Provisional is two columns and no more; detaching is narrowed to what was attached after the issuance; exposure is a list whose length is the count |
| 0028 | Superseded is a successor existing, derived and never stored; `supersedes_id` is unique, which is the whole of "at most one successor"; exposure counts only the current issuance |
| 0029 | A captured block goes in verbatim and a line of it is how an entry is addressed; counterfactuals are rows, one per assumed input; a record is bound to one submission and nothing edits it |
| 0030 | A location is four components with the grammar rendered on read; exactly one of side or sector, refused at the boundary and by a CHECK; the floor is free text; a walk exists before it is over and its date is derived from its start |
| 0031 | An issue's identifier is a high-water mark on the project, never reused and never renumbered; an issue owns no content — no summary, no location — and the sightings are its history; an open item on a finding is a join whose subject stays `PROJECT`; the category is text with a CHECK, not an enum |
| 0032 | The filename grammar is written down at last — a marker and a number, never a bare integer; a binding is stamped when the photograph is added and corrected in one action, not derived; exactly one floor window binds or nothing does; the bytes go to an `ObjectStore` port and are served through the API, not a presigned URL |
| 0033 | A record type is a file under `apps/api/src/routes/`, named to match the test file that drives it; `http.ts`, `refusals.ts` and `wire.ts` are leaves that import no route module, which is what stops the records that read each other forming a cycle; the route modules are plain functions and not plugins |
| 0034 | A draft is a record of its own, never a state of an observation; the transcript is verbatim and a correction never rewrites it; the state is four stamps with no status column beside them; transcription is the first thing on the queue; a resend after a signal drop is answered with the row rather than refused |
| 0035 | A report is a record of a rendering — nothing edits one and generating again is another row, so there is no retry route; its state is four stamps and it owns nothing it prints; an issue's identifier prints as `Issue N` and a report prints this walk's sightings, the two questions ADR-0031 deferred to issue #13 by name; the renderer is deliberately not behind a port, because a port defers a pick and a browser engine is not one |
| 0036 | Ball-in-court is a history and not a field, because an arithmetic reads it — the entry has no status column and no `ball_in_court` column, and *ball-in-court* is the last handoff derived on every read; whether the ball is ours is a stored boolean beside the party's name and never a reading of it; both registers are written with the project and there is no route that creates one; the register kind is a database enum, reversing 0031's run for the reason 0031 gave; the link to the issuance that responded is a column on the entry, because a column on the submission would need the update route 0026 made impossible |
| 0037 | The clock is elapsed in-court time summed from the handoff history and stored nowhere — `clock_started` is refused, because the ball reaches us more than once and there is no single moment a clock began; *past its clock* is three facts and one of them is that the ball is ours now, which is how a disposition takes an entry off the list without stopping anything; recording a disposition writes the outcome and hands the ball back in one transaction, and the party is supplied rather than read off the entry's fixed cast; the turnaround target is a duration in whole days, never a date, and is set once; the clock is a list whose length is the count, as exposure is; a next round is a new entry pointing backwards and inherits nothing |
| 0038 | The morning screen serves **no endpoint**: a payload carrying both counts is the first object a score could be computed from without adding a query, so the screen reads the two lists it already links to and renders their lengths. `/` is the landing view re-headed, not a route of its own, with the project list a section beneath the two counts. Both cards render at zero, unlike the project screen's strips, because here the count *is* the screen |
| 0039 | A **referenced file** is a column on a document and not the sketch's third table — the glossary calls one *a document*, so a second record would give "is this one?" two answers; it is required with no default, because a default classifies by omission and the omitted answer puts an 86-sheet set in front of extraction. `documents` is the identity and `document_versions` holds the file, departing from 0028's one-table chain because two versions share their whole identity where two links of a supersede chain share nothing; `revision` unique within its document is the whole of "a new version never overwrites a prior one". A submission's sheet list points at a **version** through a join written after the issuance, so the text column stands and 0026's per-sheet migration is still priced rather than taken. Extraction targets are a **read**, so the exclusion is one predicate rather than a `where` clause in a worker that does not exist. Not gated on employer consent: nothing here reads a document's contents |
| 0040 | Memory is versions on the project with no identity table — a project has exactly one memory, so the project is the identity; the proposal **is** the approval request, with its base snapshotted so the diff cannot drift, and is never edited — accept-with-edit writes the version and keeps the agent's words. A run is a row with four stamps, one proposal at most, and no retry: asking again is another row. The budget (4,000 characters) is surfaced and never enforced. The tools call the internal API over HTTP and never the database, their names take underscores because provider APIs reject dots, and the session's tool list is an allowlist — bash, edit and write are absent, not denied. The default adapter refuses and says so; `AGENT=pi` builds the real one. The audit is scoped to memory and append-only by construction |
| 0041 | The memory agent gets **no file tools at all**, amending 0040's tool-list section. The allowlist half of 0040 was verified and stands; the claim that `read`, `grep`, `find` and `ls` were "scoped by `cwd`" was wrong — the SDK's `resolvePath` uses `cwd` only as the base for a *relative* path, returns an absolute path as given and expands `~`, and none of the four tools carries a containment check, so a run could have read the SDK's own credential store and put it in a proposal. A containment check was refused as this product re-implementing a guarantee inside a vendor's path resolution; a memory run reads no file, so the tools are removed rather than fenced. The rule it leaves: a sandbox claimed for a vendor's tool is not a sandbox until the vendor's resolver has been read |
| 0042 | The ingest address is built and the mail provider is **not**: the port has no adapter, the default refuses, so nothing leaves the process and the employer-consent gate moves from a note in the vault to a fact about the code — it now fires on writing the adapter and naming the vendor. 0042 also prices, for the first time anywhere, that an inbound-parse provider holds the **whole message** and is a stronger consent case than the OCR API 0008 and 0013 scope the trade-off to. An arrival is **not a document**: `referenced_file`, `revision` and the title have no answer when a message lands, and inventing them is what 0039 refused. Its content type is free text where a document version's is a closed three, because refusing a `.dwg` loses the record the manual fallback protects — and the served-under-our-origin hole that opens is closed at the read, where the bytes route answers `application/octet-stream` always. `arrived_at` is stamped and the sender's `Date` header is never read. The rate limit is a count of the rows in the trailing hour, not a counter beside them |
| 0043 | Extraction is **one record** that runs, proposes and resolves — the run's stamps, the proposal's fields and the resolution on `register_entry_extractions`, the state derived and no status column. The source is **exactly one** of an arrival's file or a document version (a CHECK holds it), and the enqueue is **manual and per file**, narrowing story 84's "automatically". The OCR vendor sits behind a port whose default refuses, and the extraction agent's default refuses too — the gate kept a second time, inside the built feature, so a run fails honestly with the vendor's sentence. The agent's one tool is `extraction_propose`; the content reaches it as delimited untrusted data under an explicit directive, and the proposal is constrained to the typed shape. **Confirming is the commit**: one transaction writes the document and version (on the mail path, reusing the arrival's storage key), the register entry, its first handoff and the join. Rejecting keeps the source as it arrived. The review is against the OCR text, not a rendering — the honest version of side-by-side, since arrival bytes are deliberately served as attachments. Referenced sheets are deliberately not extracted, priced for a later ticket |

## Stack

TypeScript monorepo · Next.js · Node.js API (Fastify, ADR-0021) · PostgreSQL + Prisma · Redis + BullMQ · S3 object storage · `@earendil-works/pi-coding-agent` SDK

## Milestones and progress

The five-phase plan is superseded by the revised sequence in `PRD and Architecture.md`.

| Step | Scope | Status |
|------|-------|--------|
| 0 | Walking skeleton and test harness (issue #2) | **Done** 2026-08-24 |
| 0b | `Project` record: create, list live, view, archive (issue #3) | **Done** 2026-08-25 |
| 0c | Open items + the pending items view (issue #4) | **Done** 2026-08-25 |
| 0d | Submissions, per-project phases, sheet list, revision (issue #5) | **Done** 2026-08-25 |
| 0e | Provisional state and exposure (issue #6) | **Done** 2026-08-25 |
| 0f | Reissue and supersede (issue #7) | **Done** 2026-08-25 |
| 0g | Assumption records (issue #8) | **Done** 2026-08-27 |
| 0h | Site visits and observations (issue #9) | **Done** 2026-08-27 |
| 0i | Issues with stable per-project identifiers (issue #10) | **Done** 2026-08-27 |
| 0j | Photo binning by timestamp and filename (issue #11) | **Done** 2026-08-28 |
| 0k | Voice capture to draft observation (issue #12) | **Done** 2026-08-29 |
| 0l | The site visit report, rendered to PDF (issue #13) | **Done** 2026-08-29 |
| 0m | Registers, entries and the ball-in-court history (issue #14) | **Done** 2026-08-31 |
| 0n | The clock, dispositions and the past-its-clock view (issue #15) | **Done** 2026-08-31 |
| 0o | The morning screen: exposure and clock as the landing view (issue #16) | **Done** 2026-08-31 |
| 0p | Referenced files: documents, immutable versions, retrieval by identity (issue #17) | **Done** 2026-09-01 |
| 0q | Project memory: versions, proposals, agent runs and the audit (issue #18) | **Done** 2026-09-01 |
| 0r | The ingest address and untrusted inbound mail (issue #19) | **Done** 2026-09-01 |
| 0s | Extraction to a draft, human-confirmed (issue #20) | **Done** 2026-09-01 |
| 0s | Processing location per project (issue #21) | **Done** 2026-09-01 |
| 0t | The edge gate: one secret in front of every route (issue #22) | **Done** 2026-09-01 |
| 1 | T-1 open items entered | Unblocked — no code needed |
| 2 | Open items + submissions (provisional, supersede) | **Done** — issues #4, #5, #6, #7 |
| 3 | Site visit capture (voice, photos, stable issue IDs, the report) | **Done** — issues #9, #10, #11, #12 and #13 |
| 4 | Registers: submittals, RFIs, clock, dispositions | **Done** — issues #14 and #15 |
| 5 | Ingest: forward-to-email, extraction, human-confirmed | Referenced files (issue #17, outside the gate), the ingest address (issue #19), extraction (issue #20) and the processing location (issue #21) all done inside the gate without lifting it, and the edge gate (issue #22) done; what remains is the OCR adapter's vendor pick |
| 6 | Curated project memory | **Done** — issue #18 |

## Open decisions (deferred to implementation)

- Fly vs Render (hosting)
- Textract vs Google Document AI (OCR)
- Object storage (S3 vs R2 vs B2) — added 2026-08-28; it was on no list here or in the vault
  though the stack has said "S3-compatible" since ADR-0003. Slice 10 put it behind the
  `ObjectStore` port with a filesystem adapter, so the pick is deferred, not absent.
- SES vs Postmark vs SendGrid (email ingest)
- Transcription vendor for voice-to-observation capture (step 3) — added 2026-08-24, none named in the plan.
  Slice 11 put it behind a `Transcriber` port (ADR-0034) with **no adapter written**: the default refuses and
  says so. A step short of where object storage stands, because a filesystem is a real place to put bytes and
  there is no offline stand-in for understanding speech.

~~Clerk vs Auth0 (OIDC provider)~~ — struck 2026-08-24, dead under ADR-0012. Access control
is ADR-0020's single edge secret, which is a gate, not an identity provider.

**Two contradictions open in the vault**, recorded in `docs/adr/README.md`, neither resolved:
ADR-0013 vs the glossary on the processing-location default; and ADR-0010 / 0011 / 0006
reading Accepted while appearing in neither the MVP workflow list nor the sequence above.

## Change log

One row per slice, in [docs/changelog.md](./docs/changelog.md). Append a row there when a slice
lands; this file records the decision table and the milestone table and nothing else about a slice.
