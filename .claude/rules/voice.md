---
paths:
  - "apps/api/src/routes/voice.ts"
  - "apps/api/src/transcription.ts"
  - "apps/api/src/worker.ts"
  - "apps/api/test/voice.test.ts"
  - "apps/api/prisma/schema.prisma"
  - "apps/web/app/voice-form.tsx"
  - "apps/web/app/recordings.ts"
  - "apps/web/app/voice-captures/**"
  - "apps/web/app/site-visits/*/voice-captures/**"
  - "apps/web/app/site-visits/*/page.tsx"
  - "apps/web/app/wall-clock.ts"
---
# Voice captures and transcription

Ground rules moved out of `AGENTS.md` on 2026-09-01, none rewritten. Claude Code loads this file when a
path in the frontmatter is read through the Read tool; from the shell, read it yourself. The rules that
apply to every path stay in `AGENTS.md`.

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
