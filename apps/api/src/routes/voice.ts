/** Voice capture, and the draft observation it becomes (issue #12). */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type PrismaClient } from '../../generated/prisma/client.js';
import { type RouteDependencies, violates } from '../http.js';
import { noSuchSiteVisit, noSuchVoiceCapture } from '../refusals.js';
import { progressStreams } from '../stream.js';
import { TRANSCRIBE, type TranscribeJob } from '../worker.js';
import { voiceCaptureOnTheWire, voiceCapturesMade } from '../wire.js';
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
 * A recording on the way in.
 *
 * Base64 in the JSON body rather than multipart, for ADR-0032's reason: the
 * key, the instant and the type are then refused by the same schema as every
 * other field in this product rather than by a hand-written check on the far
 * side of a plugin.
 *
 * `recordedAt` is required and does not fall back to the injected clock, which
 * is `takenAt`'s rule and not `observedAt`'s: a recording made in a basement
 * and sent twenty minutes later when the signal returned would otherwise be
 * stamped with the moment it arrived, and the observation it becomes is dated
 * from this.
 */
const voiceCaptureBodySchema = {
  type: 'object',
  required: ['captureKey', 'recordedAt', 'contentType', 'bytes'],
  additionalProperties: false,
  properties: {
    // Minted by the phone, opaque here, and constrained to what a key can be
    // rather than to what any particular phone mints — a UUID fits, and so
    // does anything else that could not be mistaken for a sentence.
    captureKey: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' },
    recordedAt: { type: 'string', format: 'date-time' },
    contentType: { type: 'string', enum: [...AUDIO_CONTENT_TYPES] },
    // Four characters of base64 is one byte or more, so a body that passes
    // here can never decode to the nothing the CHECK constraint refuses.
    // Strict base64: whole quartets, with the only short tail being the one
    // padding makes legal. The looser `[A-Za-z0-9+/]+={0,2}` this carried
    // until now admits a length of 4n+1, which is not base64 at all, and
    // which `Buffer.from` **silently truncates** rather than refusing — so a
    // clipped recording would store and the route would answer 201, and the
    // audio the walk rests on would be short with nothing to say so. ADR-0039
    // wrote this pattern for a document version and recorded that the fix
    // here belonged to a change about this record; this is that change.
    bytes: {
      type: 'string',
      pattern:
        '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$',
      minLength: 4,
      maxLength: AUDIO_BASE64_MAX,
    },
  },
} as const;

/** The recordings on a walk, in the order they were made. */
function capturesOn(prisma: PrismaClient, siteVisitId: string) {
  return prisma.voiceCapture
    .findMany({ where: { siteVisitId }, ...voiceCapturesMade })
    .then((rows) => rows.map(voiceCaptureOnTheWire));
}

export function voiceRoutes(
  v1: FastifyInstance,
  { prisma, queue, objectStore, timeSource }: RouteDependencies,
): void {
  const stream = progressStreams(v1);

  /**
   * Recording an observation by speaking (story 51).
   *
   * The audio goes to the store and a job goes on the queue; what the
   * vendor heard arrives later and is a **draft** until the engineer
   * commits it below. Nothing here writes an observation.
   *
   * **A repeat is answered, not refused.** The phone holds the recording
   * until this returns, and sends it again when the signal comes back
   * (story 112) — so the same `captureKey` gets the row that already
   * exists, with 200 rather than 201. A photograph's duplicate filename is
   * refused (ADR-0032) because there the refusal *is* the answer: the walk
   * already has that file. Here a refusal would leave the phone unable to
   * tell "already landed" from "never landed", and it would then either
   * keep the recording forever or throw one away.
   */
  v1.post<{
    Params: { id: string };
    Body: {
      captureKey: string;
      recordedAt: string;
      contentType: string;
      bytes: string;
    };
  }>(
    '/site-visits/:id/voice-captures',
    { schema: { body: voiceCaptureBodySchema }, bodyLimit: AUDIO_BODY_LIMIT },
    async (request, reply) => {
      const walk = await prisma.siteVisit.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (walk === null) {
        return noSuchSiteVisit(reply);
      }

      const { captureKey, contentType } = request.body;
      /** The recording already stored under this key on this walk, or null. */
      const existing = () =>
        prisma.voiceCapture.findUnique({
          where: {
            siteVisitId_captureKey: { siteVisitId: walk.id, captureKey },
          },
          include: { observation: true },
        });

      const already = await existing();
      if (already !== null) {
        // The recording is here and the phone can let go of it. Nothing is
        // re-stored and nothing is re-queued: the transcript it already has,
        // or the failure, is what a retry is for.
        return voiceCaptureOnTheWire(already);
      }

      const bytes = Buffer.from(request.body.bytes, 'base64');

      // Bytes first, row second, and never both in one transaction — the
      // order ADR-0032 settled for a photograph, for the same reason: a
      // `put` against the S3 adapter is a network write, and holding a
      // database connection across it blows Prisma's interactive-transaction
      // timeout and rolls back a row whose object already stored.
      const storageKey = `voice/${randomUUID()}`;
      await objectStore.put(storageKey, bytes, contentType);

      let stored;
      try {
        stored = await prisma.voiceCapture.create({
          data: {
            siteVisitId: walk.id,
            captureKey,
            recordedAt: new Date(request.body.recordedAt),
            contentType,
            byteSize: bytes.byteLength,
            storageKey,
            createdAt: timeSource.now(),
          },
          include: { observation: true },
        });
      } catch (error) {
        // Two sends of the same recording crossing in flight. The read above
        // missed it, the insert did not, and the answer is still the row —
        // narrowed to the key, because the insert also writes a fresh storage
        // key whose collision would mean something else entirely.
        if (violates(error, 'capture_key')) {
          const raced = await existing();
          if (raced !== null) {
            return voiceCaptureOnTheWire(raced);
          }
        }
        throw error;
      }

      // After the row and outside any transaction. If this throws, the
      // recording is safely stored and reads as queued, and the retry route
      // below is the way on — which is strictly better than a 500 that also
      // loses the audio.
      await queue.add(TRANSCRIBE, {
        voiceCaptureId: stored.id,
      } satisfies TranscribeJob);

      return reply.code(201).send(voiceCaptureOnTheWire(stored));
    },
  );

  /**
   * The audio itself, served through the API.
   *
   * Not a presigned URL, for the reason a photograph's bytes are not
   * ([[0020]] is still Proposed) — and this route is half of what "a failed
   * or rejected transcription leaves the audio recoverable" means. The
   * other half is the retry below; between them, the engineer can listen to
   * what they said and write it down by hand.
   */
  v1.get<{ Params: { id: string } }>(
    '/voice-captures/:id/audio',
    async (request, reply) => {
      const found = await prisma.voiceCapture.findUnique({
        where: { id: request.params.id },
        select: { storageKey: true, contentType: true },
      });
      if (found === null) {
        return noSuchVoiceCapture(reply);
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
   * The draft, corrected, becoming an observation (story 52).
   *
   * The corrected words are the observation's; `transcript` is left exactly
   * as the vendor returned it. Keeping both is what makes "transcription
   * error never became record error" something anybody can check
   * afterwards — one column says what was heard and the other says what was
   * recorded, and ADR-0029 took the same position about a captured block.
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
   */
  v1.post<{ Params: { id: string }; Body: ObservationBody }>(
    '/voice-captures/:id/observation',
    { schema: { body: observationBodySchema } },
    async (request, reply) => {
      const capture = await prisma.voiceCapture.findUnique({
        where: { id: request.params.id },
        select: { id: true, siteVisitId: true, recordedAt: true },
      });
      if (capture === null) {
        return noSuchVoiceCapture(reply);
      }

      // The day and the minute the engineer was standing there, not the
      // evening they reviewed it. A supplied instant still wins, because a
      // correction may be about the time as much as the words.
      const observedAt =
        request.body.observedAt === undefined
          ? capture.recordedAt
          : new Date(request.body.observedAt);

      const committed = await prisma.$transaction(async (tx) => {
        const observation = await tx.observation.create({
          data: observationData(
            request.body,
            capture.siteVisitId,
            observedAt,
            timeSource.now(),
          ),
        });

        // Compare-and-set, so the second half of a double tap writes
        // nothing rather than a second observation saying the same thing.
        // A plain read-then-update would let both through, and a number of
        // observations is not a thing this product can take back.
        const claimed = await tx.voiceCapture.updateMany({
          where: { id: capture.id, observationId: null },
          data: { observationId: observation.id },
        });
        if (claimed.count !== 1) {
          throw new AlreadyCommitted();
        }

        return tx.voiceCapture.findUniqueOrThrow({
          where: { id: capture.id },
          include: { observation: true },
        });
      }).catch((error: unknown) => {
        if (error instanceof AlreadyCommitted) {
          return null;
        }
        throw error;
      });

      if (committed === null) {
        return reply.code(409).send({
          message: 'that voice capture has already become an observation',
        });
      }
      return reply.code(201).send(voiceCaptureOnTheWire(committed));
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
   */
  v1.post<{ Params: { id: string } }>(
    '/voice-captures/:id/retry',
    async (request, reply) => {
      const capture = await prisma.voiceCapture.findUnique({
        where: { id: request.params.id },
        select: { id: true, transcribedAt: true, observationId: true },
      });
      if (capture === null) {
        return noSuchVoiceCapture(reply);
      }
      if (capture.observationId !== null) {
        return reply.code(409).send({
          message: 'that voice capture has already become an observation',
        });
      }
      if (capture.transcribedAt !== null) {
        // Refused rather than repeated, for the reason a second close is:
        // a second transcript would silently overwrite the words the
        // engineer is part-way through correcting.
        return reply.code(409).send({
          message: 'that voice capture has already been transcribed',
        });
      }

      const reset = await prisma.voiceCapture.update({
        where: { id: capture.id },
        data: { transcribingSince: null, failedAt: null, failure: null },
        include: { observation: true },
      });
      await queue.add(TRANSCRIBE, {
        voiceCaptureId: reset.id,
      } satisfies TranscribeJob);

      return voiceCaptureOnTheWire(reset);
    },
  );

  /**
   * Progress while it runs, so a slow transcription does not look like a
   * broken feature (the ticket; story 90's shape, applied here).
   *
   * The stream itself is `stream.ts`, which a walk's reports reach for too
   * (issue #13). What is this record's is the reader: the recordings on this
   * walk, in the order they were made.
   */
  v1.get<{ Params: { id: string } }>(
    '/site-visits/:id/voice-captures/stream',
    async (request, reply) => {
      const walk = await prisma.siteVisit.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (walk === null) {
        return noSuchSiteVisit(reply);
      }

      return stream(request, reply, () => capturesOn(prisma, walk.id));
    },
  );
}

/**
 * The compare-and-set losing, which is a 409 and not a 500.
 *
 * A class rather than a sentinel value because it has to travel out of an
 * interactive transaction, and throwing is the only way to make that
 * transaction roll the observation back with it.
 */
class AlreadyCommitted extends Error {}
