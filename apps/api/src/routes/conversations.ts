/**
 * The conversation on a site visit: its turns, the draft each capture becomes,
 * and the run that proposes one (issue #12, widened by issue #114).
 *
 * This file was `routes/voice.ts`. The record is the same one renamed and
 * widened twice: ADR-0057 made a capture one record whether it was spoken or
 * typed, and ADR-0058 made the conversation itself a record, so `voice_captures`
 * became `turns` under a `conversations` row. Everything issue #12 settled
 * still holds — the draft is the row, the transcript is never rewritten, the
 * state is four stamps, and a resend under the same key is answered rather than
 * refused.
 *
 * What is new is the second kind of capture and the agent's reply. A typed turn
 * queues a proposal run; the run reads the walk through the routes, receives the
 * conversation as delimited untrusted data, and calls one mutating tool, which
 * lands on `POST /capture-runs/:id/proposal` below and writes **a turn** — the
 * agent's own, carrying the draft's fields or the question it has instead. The
 * agent never writes an observation: confirming does, and confirming is the
 * engineer's.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  type Prisma,
  type PrismaClient,
} from '../../generated/prisma/client.js';
import { BASE64, type RouteDependencies, violates } from '../http.js';
import { noSuchSiteVisit, noSuchTurn } from '../refusals.js';
import { progressStreams } from '../stream.js';
import { PROPOSE_CAPTURE, TRANSCRIBE } from '../worker.js';
import type { ProposeCaptureJob, TranscribeJob } from '../worker.js';
import {
  conversationHeld,
  conversationOnTheWire,
  turnOnTheWire,
} from '../wire.js';
import { audit } from '../audit.js';
import { actorOf, callerOf, mintRunSession } from '../gate.js';
import {
  type ObservationBody,
  observationBodySchema,
  observationData,
} from './site-visits.js';

/**
 * The audio types the boundary admits, byte-exact and closed.
 *
 * Exactly three, because exactly three are what the one place recordings are
 * made produces: Chrome and Android give WebM, Safari and iOS give MP4,
 * Firefox gives Ogg. Closed rather than any `audio/*` for the reason the image
 * types are — the read route hands this value straight back as the response's
 * content type. A CHECK constraint names the same three underneath.
 *
 * A browser reports `audio/webm;codecs=opus`; the codec parameter is dropped
 * on the screen that records, because what is stored is what is served and a
 * parameter is not part of what the file is.
 */
const AUDIO_CONTENT_TYPES = ['audio/webm', 'audio/mp4', 'audio/ogg'] as const;

/**
 * The longest base64 string the boundary takes, which is six mebibytes of
 * file. Named for the string because that is what `maxLength` measures.
 *
 * The cap the plan does not state. A spoken observation is a sentence or two;
 * a minute of Opus is about 180 kilobytes and a minute of the AAC an iPhone
 * records is about 500, so six mebibytes is a quarter of an hour of talking
 * into one observation — far past anything story 51 describes, and still small
 * enough that a phone on cellular can send it.
 */
const AUDIO_BASE64_MAX = 8_388_608;

/** The body plus its JSON, so the limit refuses a recording and not a request. */
const AUDIO_BODY_LIMIT = AUDIO_BASE64_MAX + 64 * 1024;

/**
 * What the engineer typed, bounded where a recording's bytes are.
 *
 * `observations.observed`'s 2,000 would be the obvious number and is the wrong
 * one: a turn is what was *said*, and the observation it becomes is a
 * correction of it. Four thousand is the memory budget's figure — the other
 * bound in this product on prose a person wrote in one go — and a turn past it
 * is a paragraph nobody typed one-handed on a walk.
 */
const TYPED_MAX = 4_000;

/** Minted by the client, opaque here, and never mistakable for a sentence. */
const CAPTURE_KEY = {
  type: 'string',
  pattern: '^[A-Za-z0-9_-]{8,64}$',
} as const;

/**
 * A capture on the way in, spoken or typed (ADR-0057).
 *
 * **One route and one body with two branches**, not two routes: a capture is
 * one record, and two routes would be two places its key, its instant and its
 * resend rule were each spelled. The branches are exclusive by `oneOf`, so a
 * body carrying both audio and typed words is a 400 at the boundary rather
 * than a row the CHECK underneath refuses at the last moment.
 *
 * Base64 in the JSON body rather than multipart, for ADR-0032's reason: the
 * key, the instant and the type are then refused by the same schema as every
 * other field in this product rather than by a hand-written check on the far
 * side of a plugin.
 *
 * `recordedAt` is required on both kinds and does not fall back to the injected
 * clock, which is `takenAt`'s rule and not `observedAt`'s: a capture made in a
 * basement and sent twenty minutes later when the signal returned would
 * otherwise be stamped with the moment it arrived, and the observation it
 * becomes is dated from this.
 */
const turnBodySchema = {
  type: 'object',
  required: ['kind', 'captureKey', 'recordedAt'],
  properties: {
    kind: { type: 'string', enum: ['VOICE', 'TYPED'] },
    captureKey: CAPTURE_KEY,
    recordedAt: { type: 'string', format: 'date-time' },
    contentType: { type: 'string', enum: [...AUDIO_CONTENT_TYPES] },
    // Strict base64: the alphabet, the padding position, and whole quartets.
    // A length of 4n+1 is not base64 at all and `Buffer.from` **silently
    // truncates** it rather than refusing — so a clipped recording would
    // store and the route would answer 201, and the audio the walk rests on
    // would be short with nothing to say so. ADR-0039 wrote that rule for a
    // document version and recorded that the fix here belonged to a change
    // about this record; issue #54 was that change. It is `isBase64` and no
    // longer a pattern because the pattern recursed into a 500 (issue #98),
    // which on this record is the failure that loses the recording.
    bytes: { ...BASE64, maxLength: AUDIO_BASE64_MAX },
    text: { type: 'string', pattern: '\\S', maxLength: TYPED_MAX },
  },
  oneOf: [
    {
      properties: { kind: { const: 'VOICE' } },
      required: ['contentType', 'bytes'],
      not: { required: ['text'] },
    },
    {
      properties: { kind: { const: 'TYPED' } },
      required: ['text'],
      not: { anyOf: [{ required: ['contentType'] }, { required: ['bytes'] }] },
    },
  ],
  additionalProperties: false,
} as const;

interface TurnBody {
  kind: 'VOICE' | 'TYPED';
  captureKey: string;
  recordedAt: string;
  contentType?: string;
  bytes?: string;
  text?: string;
}

/**
 * What the agent proposes: the draft's fields, or the question it has instead
 * (ADR-0057 part 3).
 *
 * The fields branch is `observationBodySchema` with `observedAt` left out and
 * the sighting added — validated against **the same one-axis rule the two
 * writers of `observations` use**, imported rather than restated. ADR-0030
 * wrote that rule into a CHECK precisely because it expected another writer and
 * expected it to forget.
 *
 * A proposal is either fields or a question and never both. That is not
 * tidiness: the engineer's screen either shows a draft to confirm or a question
 * to answer, and a body carrying both would leave which one it is to whoever
 * read it next.
 */
const { observedAt: _notProposed, ...proposableFields } =
  observationBodySchema.properties;

const proposalBodySchema = {
  type: 'object',
  properties: {
    ...proposableFields,
    issueId: { type: 'string', format: 'uuid' },
    question: { type: 'string', pattern: '\\S', maxLength: TYPED_MAX },
  },
  oneOf: [
    {
      required: [...observationBodySchema.required],
      not: { required: ['question'] },
      oneOf: [...observationBodySchema.oneOf],
    },
    {
      required: ['question'],
      not: {
        anyOf: [
          { required: ['observed'] },
          { required: ['floor'] },
          { required: ['qualifier'] },
          { required: ['side'] },
          { required: ['sector'] },
          { required: ['issueId'] },
        ],
      },
    },
  ],
  additionalProperties: false,
} as const;

interface ProposalBody extends Partial<ObservationBody> {
  issueId?: string;
  question?: string;
}

/**
 * What the walk's conversation panel watches: its turns in order, and the
 * state of the runs held on it.
 *
 * Both, because they are two halves of one question — what has been said, and
 * whether anything is still coming. The memory stream carries two lists for
 * the same reason (`{runs, proposals}`), and `useLiveList` has been generic
 * over the payload since that slice.
 */
function conversationOf(prisma: PrismaClient, siteVisitId: string) {
  return prisma.siteVisit
    .findUniqueOrThrow({
      where: { id: siteVisitId },
      select: { conversation: conversationHeld },
    })
    .then(({ conversation }) => {
      const { turns, runs } = conversationOnTheWire(conversation!);
      return { turns, runs };
    });
}

/**
 * The next position in a conversation, taken under a lock on that conversation.
 *
 * `routes/phases.ts`'s shape and for its reason, written down there: counting
 * and then inserting is two statements, so without the lock two turns arriving
 * in the same instant read the same count and both take it — and `position` is
 * unique per conversation, so one of them would 500 instead of landing. A lock
 * per conversation, so one walk's turns cannot wait on another's.
 *
 * Prefixed, as the phase lock and the ingest lock are, so the three are three
 * locks: they guard different things and a turn waiting behind a piece of
 * inbound mail would be a coupling nobody asked for.
 */
async function nextPosition(
  tx: Prisma.TransactionClient,
  conversationId: string,
): Promise<number> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`turn-order:${conversationId}`}))`;
  return (await tx.turn.count({ where: { conversationId } })) + 1;
}

/** The walk's conversation, which every route here is about. */
async function conversationOn(prisma: PrismaClient, siteVisitId: string) {
  return prisma.conversation.findUnique({
    where: { siteVisitId },
    select: { id: true, projectId: true, siteVisitId: true },
  });
}

export function conversationRoutes(
  v1: FastifyInstance,
  { prisma, queue, objectStore, timeSource }: RouteDependencies,
): void {
  const stream = progressStreams(v1);

  /**
   * The walk's conversation, with every turn in order.
   *
   * A read of its own as well as a branch of `GET /site-visits/:id`, because
   * the conversation is a record now: the walk's screen wants it with
   * everything else, and the panel that polls wants only this.
   */
  v1.get<{ Params: { id: string } }>(
    '/site-visits/:id/conversation',
    async (request, reply) => {
      const walk = await prisma.siteVisit.findUnique({
        where: { id: request.params.id },
        select: { id: true, conversation: conversationHeld },
      });
      if (walk === null || walk.conversation === null) {
        return noSuchSiteVisit(reply);
      }
      return conversationOnTheWire(walk.conversation);
    },
  );

  /**
   * The engineer's turn: what was spoken, or what was typed (story 51,
   * ADR-0057).
   *
   * A recording's audio goes to the store and a transcription job goes on the
   * queue; what the vendor heard arrives later. Typed words are here already,
   * so what goes on the queue instead is a **proposal run** — the agent reads
   * the walk and answers with a turn of its own carrying a draft or a question.
   * Nothing here writes an observation either way.
   *
   * **A repeat is answered, not refused.** The client holds the capture until
   * this returns and sends it again when the signal comes back (story 112) —
   * so the same `captureKey` gets the row that already exists, with 200 rather
   * than 201. A photograph's duplicate filename is refused (ADR-0032) because
   * there the refusal *is* the answer: the walk already has that file. Here a
   * refusal would leave the client unable to tell "already landed" from "never
   * landed", and it would then either keep the capture forever or throw one
   * away. ADR-0057 extends that to a typed turn, and nothing about the reason
   * was ever specific to audio.
   */
  v1.post<{ Params: { id: string }; Body: TurnBody }>(
    '/site-visits/:id/turns',
    { schema: { body: turnBodySchema }, bodyLimit: AUDIO_BODY_LIMIT },
    async (request, reply) => {
      const conversation = await conversationOn(prisma, request.params.id);
      if (conversation === null) {
        return noSuchSiteVisit(reply);
      }

      const { captureKey, kind } = request.body;
      /** The turn already taken under this key on this walk, or null. */
      const existing = () =>
        prisma.turn.findUnique({
          where: {
            conversationId_captureKey: {
              conversationId: conversation.id,
              captureKey,
            },
          },
          include: { observation: true },
        });

      const already = await existing();
      if (already !== null) {
        // The capture is here and the client can let go of it. Nothing is
        // re-stored, nothing is re-queued and no second run is asked for: the
        // transcript it already has, the failure, or the reply already on the
        // conversation is what a retry is for. **And nothing is audited** — a
        // resend writes no row, so a line here would say the walk had two
        // captures on the day the signal dropped once (ADR-0034).
        return turnOnTheWire(already);
      }

      const bytes =
        request.body.bytes === undefined
          ? null
          : Buffer.from(request.body.bytes, 'base64');

      // Bytes first, row second, and never both in one transaction — the
      // order ADR-0032 settled for a photograph, for the same reason: a
      // `put` against the S3 adapter is a network write, and holding a
      // database connection across it blows Prisma's interactive-transaction
      // timeout and rolls back a row whose object already stored.
      const storageKey = bytes === null ? null : `voice/${randomUUID()}`;
      if (bytes !== null && storageKey !== null) {
        await objectStore.put(storageKey, bytes, request.body.contentType!);
      }

      const at = timeSource.now();
      let stored;
      try {
        stored = await prisma.$transaction(async (tx) => {
          const turn = await tx.turn.create({
            data: {
              conversationId: conversation.id,
              speaker: 'ENGINEER',
              position: await nextPosition(tx, conversation.id),
              kind,
              captureKey,
              recordedAt: new Date(request.body.recordedAt),
              contentType: request.body.contentType ?? null,
              byteSize: bytes?.byteLength ?? null,
              storageKey,
              // What was typed is what was said, verbatim and from the first
              // instant — the one thing a typed capture does not wait for a
              // vendor to tell it (ADR-0057). Nothing rewrites it here either.
              transcript: request.body.text ?? null,
              createdAt: at,
            },
            include: { observation: true },
          });

          // A typed turn asks the agent for a draft, and the run is written in
          // the same transaction as the turn that asked for it: a run nobody
          // can point at a turn for is a run nobody asked for.
          const run =
            kind === 'TYPED'
              ? await tx.agentRun.create({
                  data: {
                    projectId: conversation.projectId,
                    conversationId: conversation.id,
                    createdAt: at,
                  },
                  select: { id: true },
                })
              : null;
          if (run !== null) {
            // The run's own session, in the name of whoever typed: the agent's
            // tools call this API like any other caller (issue #105,
            // ADR-0055). Written here, so a run never exists without the
            // credential its worker will look for.
            await mintRunSession(
              tx,
              { agentRunId: run.id },
              callerOf(request).userId,
              at,
            );
          }

          await audit(tx, {
            projectId: conversation.projectId,
            actor: actorOf(request),
            subject: { type: 'turn', id: turn.id },
            action: kind === 'VOICE' ? 'capture recorded' : 'capture typed',
            detail: `${turn.captureKey ?? ''}, captured ${turn.recordedAt?.toISOString() ?? ''}`,
            at,
          });
          return { turn, runId: run?.id ?? null };
        });
      } catch (error) {
        // Two sends of the same capture crossing in flight. The read above
        // missed it, the insert did not, and the answer is still the row —
        // narrowed to the key, because the insert also writes a fresh storage
        // key whose collision would mean something else entirely.
        if (violates(error, 'capture_key')) {
          const raced = await existing();
          if (raced !== null) {
            return turnOnTheWire(raced);
          }
        }
        throw error;
      }

      // After the row and outside any transaction. If this throws, the capture
      // is safely stored and reads as queued, and the retry route below is the
      // way on — which is strictly better than a 500 that also loses it.
      if (stored.runId === null) {
        await queue.add(TRANSCRIBE, {
          turnId: stored.turn.id,
        } satisfies TranscribeJob);
      } else {
        await queue.add(PROPOSE_CAPTURE, {
          agentRunId: stored.runId,
        } satisfies ProposeCaptureJob);
      }

      return reply.code(201).send(turnOnTheWire(stored.turn));
    },
  );

  /**
   * The audio itself, served through the API.
   *
   * Not a presigned URL, for the reason a photograph's bytes are not
   * ([[0020]] read *still Proposed* here until issue #84; it was Accepted
   * 2026-09-01) — and this route is half of what "a failed
   * or rejected transcription leaves the audio recoverable" means. The
   * other half is the retry below; between them, the engineer can listen to
   * what they said and write it down by hand.
   *
   * A turn with no recording — typed, or the agent's — is a **404** and not an
   * empty body: there is no audio, and a zero-byte answer under an audio
   * content type is a file that fails to play for a reason nobody can read.
   */
  v1.get<{ Params: { id: string } }>(
    '/turns/:id/audio',
    async (request, reply) => {
      const found = await prisma.turn.findUnique({
        where: { id: request.params.id },
        select: { storageKey: true, contentType: true },
      });
      if (found === null || found.storageKey === null || found.contentType === null) {
        return noSuchTurn(reply);
      }

      const bytes = await objectStore.get(found.storageKey);
      return reply
        .header('content-type', found.contentType)
        // One of three audio types, and the browser is told not to look for
        // a fourth.
        .header('x-content-type-options', 'nosniff')
        .send(bytes);
    },
  );

  /**
   * The draft, corrected, becoming an observation (story 52; the confirm
   * ADR-0057 part 3 makes the commit).
   *
   * The corrected words are the observation's; `transcript` is left exactly
   * as it arrived. Keeping both is what makes "transcription error never
   * became record error" something anybody can check afterwards — one column
   * says what was said and the other says what was recorded, and ADR-0029
   * took the same position about a captured block.
   *
   * Allowed on a **failed** capture too, and that is the point: the audio
   * is there to listen to, and a vendor that never answered must not be
   * able to stop the walk being written up.
   *
   * Validated against the **same schema** the typed route uses, imported
   * rather than restated. ADR-0030 wrote the one-axis rule into a CHECK
   * constraint precisely because it expected this route to exist and to
   * forget — "story 55 is about the grammar not being corruptible *by the
   * interface*, which is exactly the guard a later writer forgets".
   *
   * The **agent's** turn is refused here, and that refusal is the ticket's
   * "the agent never writes an observation" at the boundary, beside the CHECK
   * that says the same underneath.
   */
  v1.post<{ Params: { id: string }; Body: ObservationBody }>(
    '/turns/:id/observation',
    { schema: { body: observationBodySchema } },
    async (request, reply) => {
      const turn = await prisma.turn.findUnique({
        where: { id: request.params.id },
        select: {
          id: true,
          speaker: true,
          recordedAt: true,
          transcript: true,
          conversation: {
            select: { projectId: true, siteVisitId: true },
          },
        },
      });
      if (turn === null) {
        return noSuchTurn(reply);
      }
      if (turn.speaker === 'AGENT' || turn.conversation.siteVisitId === null) {
        return agentWritesNoObservation(reply);
      }

      // The day and the minute the engineer was standing there, not the
      // evening they reviewed it. A supplied instant still wins, because a
      // correction may be about the time as much as the words.
      const observedAt =
        request.body.observedAt === undefined
          ? turn.recordedAt!
          : new Date(request.body.observedAt);

      const siteVisitId = turn.conversation.siteVisitId;
      const at = timeSource.now();
      const committed = await prisma
        .$transaction(async (tx) => {
          const observation = await tx.observation.create({
            data: observationData(request.body, siteVisitId, observedAt, at),
          });

          // Compare-and-set, so the second half of a double tap writes
          // nothing rather than a second observation saying the same thing.
          // A plain read-then-update would let both through, and a number of
          // observations is not a thing this product can take back.
          const claimed = await tx.turn.updateMany({
            where: { id: turn.id, observationId: null },
            data: { observationId: observation.id },
          });
          if (claimed.count !== 1) {
            throw new AlreadyCommitted();
          }

          // Whether the engineer changed the words that were captured, which is
          // the fact keeping both columns exists to make checkable (ADR-0034).
          // Neither text is quoted: the transcript stands on the row and the
          // observation stands on its own, and an audit that copied either
          // would be a second place the same words live.
          await audit(tx, {
            projectId: turn.conversation.projectId,
            actor: actorOf(request),
            subject: { type: 'turn', id: turn.id },
            action:
              turn.transcript !== null &&
              turn.transcript === observation.observed
                ? 'capture committed verbatim'
                : 'capture committed with corrections',
            detail: `observed ${observation.observedAt.toISOString()}`,
            at,
          });

          return tx.turn.findUniqueOrThrow({
            where: { id: turn.id },
            include: { observation: true },
          });
        })
        .catch((error: unknown) => {
          if (error instanceof AlreadyCommitted) {
            return null;
          }
          throw error;
        });

      if (committed === null) {
        return reply.code(409).send({
          message: 'that capture has already become an observation',
        });
      }
      return reply.code(201).send(turnOnTheWire(committed));
    },
  );

  /**
   * Asking the vendor again.
   *
   * The other half of "leaves the audio recoverable": the failure is
   * cleared and a fresh job goes on, the way reopening an issue clears
   * `closed_at` and `closure_note` (ADR-0031). The worker does not retry on
   * its own — a vendor that rejected this audio will reject it again, and
   * an attempt nobody asked for would move the state under a screen
   * somebody is reading.
   *
   * A capture stuck at *queued* after a restart is the same call: Redis has
   * no volume in this stack, so a job can be lost while its row cannot be.
   *
   * There is nothing to ask again about a **typed** turn: its words arrived
   * with it, and a proposal run that failed is another run rather than a retry
   * (ADR-0035's reason, which is `agent_runs`' already).
   */
  v1.post<{ Params: { id: string } }>(
    '/turns/:id/retry',
    async (request, reply) => {
      const turn = await prisma.turn.findUnique({
        where: { id: request.params.id },
        select: {
          id: true,
          kind: true,
          captureKey: true,
          transcribedAt: true,
          observationId: true,
          failure: true,
          conversation: { select: { projectId: true } },
        },
      });
      if (turn === null) {
        return noSuchTurn(reply);
      }
      if (turn.kind !== 'VOICE') {
        return reply
          .code(409)
          .send({ message: 'that turn has no recording to transcribe' });
      }
      if (turn.observationId !== null) {
        return reply.code(409).send({
          message: 'that capture has already become an observation',
        });
      }
      if (turn.transcribedAt !== null) {
        // Refused rather than repeated, for the reason a second close is:
        // a second transcript would silently overwrite the words the
        // engineer is part-way through correcting.
        return reply.code(409).send({
          message: 'that capture has already been transcribed',
        });
      }

      const at = timeSource.now();
      const reset = await prisma.$transaction(async (tx) => {
        const cleared = await tx.turn.update({
          where: { id: turn.id },
          data: { transcribingSince: null, failedAt: null, failure: null },
          include: { observation: true },
        });
        // The failure is about to be cleared, so what the vendor said survives
        // here or nowhere — the reason a reopen names the closure it cleared.
        await audit(tx, {
          projectId: turn.conversation.projectId,
          actor: actorOf(request),
          subject: { type: 'turn', id: cleared.id },
          action: 'transcription asked for again',
          detail:
            turn.failure === null
              ? `${turn.captureKey ?? ''}, which had not failed`
              : `${turn.captureKey ?? ''}, after "${turn.failure}"`,
          at,
        });
        return cleared;
      });
      await queue.add(TRANSCRIBE, {
        turnId: reset.id,
      } satisfies TranscribeJob);

      return turnOnTheWire(reset);
    },
  );

  /**
   * The agent's one mutating tool lands here (issue #114, ADR-0057 part 3).
   *
   * What it writes is **a turn** — the agent's reply on the conversation,
   * carrying either the draft's fields or the question it has instead. It is
   * not an observation and cannot become one: the CHECK under this table
   * refuses `observation_id` on an agent turn, and the confirm route above
   * refuses an agent turn by name. The engineer's confirm is the commit.
   *
   * One turn per run: `agent_run_id` is unique, and a second call is refused
   * by the database rather than by a guard — `memory-runs/:id/proposal`'s
   * shape exactly.
   *
   * The typed-shape constraint lives in the body schema above and not in the
   * prompt, for ADR-0043's reason: a prompt is not a place a constraint can be
   * held.
   */
  v1.post<{ Params: { id: string }; Body: ProposalBody }>(
    '/capture-runs/:id/proposal',
    { schema: { body: proposalBodySchema } },
    async (request, reply) => {
      const run = await prisma.agentRun.findUnique({
        where: { id: request.params.id },
        select: {
          id: true,
          projectId: true,
          conversationId: true,
          finishedAt: true,
          failedAt: true,
        },
      });
      if (run === null || run.conversationId === null) {
        return reply
          .code(404)
          .send({ message: 'no capture run with that id' });
      }
      if (run.finishedAt !== null || run.failedAt !== null) {
        // ADR-0043's "a proposal for a run that is not running is a 409", and
        // for its reason: a settled run's reply would land on a conversation
        // whose screen has already said what happened to it.
        return reply
          .code(409)
          .send({ message: 'that run has already settled' });
      }

      const conversationId = run.conversationId;
      const { question, issueId, ...fields } = request.body;
      // A finding on another job is not this walk's to be a sighting of, and
      // the proposal names one by id — so it is checked here rather than left
      // to the foreign key, which would 500 on a stranger's uuid.
      if (issueId !== undefined) {
        const finding = await prisma.issue.findUnique({
          where: { id: issueId },
          select: { projectId: true },
        });
        if (finding === null || finding.projectId !== run.projectId) {
          return reply
            .code(404)
            .send({ message: 'no issue with that id on this project' });
        }
      }

      const at = timeSource.now();
      try {
        const written = await prisma.$transaction(async (tx) => {
          const turn = await tx.turn.create({
            data: {
              conversationId,
              speaker: 'AGENT',
              position: await nextPosition(tx, conversationId),
              agentRunId: run.id,
              // The question is the agent's words, in the one column a turn's
              // words live in (ADR-0058: "its text verbatim"). A proposal that
              // carries fields carries no words at all, and that is not a
              // missing value: the draft is what it said.
              transcript: question ?? null,
              proposedObserved: fields.observed ?? null,
              proposedFloor: fields.floor ?? null,
              proposedQualifier: fields.qualifier ?? null,
              proposedSide: fields.side ?? null,
              proposedSector: fields.sector ?? null,
              proposedIssueId: issueId ?? null,
              createdAt: at,
            },
            include: { observation: true },
          });
          await audit(tx, {
            projectId: run.projectId,
            actor: actorOf(request),
            subject: { type: 'turn', id: turn.id },
            action:
              question === undefined ? 'draft proposed' : 'question asked',
            // Neither the question nor the draft is quoted: both stand on the
            // turn, and a line carrying them would be a second place the
            // agent's words lived.
            detail:
              question === undefined
                ? `on floor ${fields.floor ?? ''}`
                : 'a field could not be proposed',
            at,
          });
          return turn;
        });
        return reply.code(201).send(turnOnTheWire(written));
      } catch (error) {
        // Narrowed to the run: one run, at most one turn.
        if (violates(error, 'agent_run_id')) {
          return reply
            .code(409)
            .send({ message: 'that run has already answered' });
        }
        throw error;
      }
    },
  );

  /**
   * Progress while it runs, so a slow transcription or a slow model does not
   * look like a broken feature (the ticket; story 90's shape, applied here).
   *
   * The stream itself is `stream.ts`, which a walk's reports reach for too
   * (issue #13). What is this record's is the reader: the conversation's turns,
   * in order — which is also how the agent's reply appears without a reload.
   */
  v1.get<{ Params: { id: string } }>(
    '/site-visits/:id/conversation/stream',
    async (request, reply) => {
      const conversation = await conversationOn(prisma, request.params.id);
      if (conversation === null) {
        return noSuchSiteVisit(reply);
      }

      return stream(request, reply, () =>
        conversationOf(prisma, request.params.id),
      );
    },
  );
}

/**
 * The one sentence for an agent turn offered where a capture belongs.
 *
 * A 409 and not a 404: the turn exists and the caller named it correctly, and
 * what is refused is the act. "The agent never writes an observation" is the
 * ticket's own sentence and this is where a caller is told so.
 */
function agentWritesNoObservation(reply: FastifyReply) {
  return reply.code(409).send({
    message: 'only a capture becomes an observation, and that is the engineer’s turn',
  });
}

/**
 * The compare-and-set losing, which is a 409 and not a 500.
 *
 * A class rather than a sentinel value because it has to travel out of an
 * interactive transaction, and throwing is the only way to make that
 * transaction roll the observation back with it.
 */
class AlreadyCommitted extends Error {}
