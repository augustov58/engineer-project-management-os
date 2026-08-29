/**
 * The transcription worker: the first thing in this product that runs off the
 * request (issue #12).
 *
 * BullMQ has been wired and idle since slice 1, and ADR-0032 deliberately kept
 * photo binning out of it — "date comparison and one regular expression". That
 * reasoning does not reach here. Asking a vendor what was said in two minutes
 * of audio is a network call of unbounded duration, and the ticket's own
 * progress criterion presupposes that the request has long since returned.
 *
 * It runs in the API's process. ADR-0012 makes this a single-user tool, one
 * process is one thing to start and stop, and `buildWorker` takes the same
 * injected dependencies `buildServer` does — so the test harness gets a real
 * worker over a real Redis the same way production does, rather than by a
 * second copy of the wiring staying in step. Splitting it into its own process
 * later is a deployment change and touches nothing above this file.
 */

import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { ObjectStore } from './object-store.js';
import type { TimeSource } from './time-source.js';
import type { Transcriber } from './transcription.js';

/** The one job kind on the queue. */
export const TRANSCRIBE = 'transcribe';

/**
 * The id and nothing else. Everything the job needs is on the row, so a job
 * that sat in Redis across a restart cannot carry a stale copy of it.
 */
export interface TranscribeJob {
  voiceCaptureId: string;
}

export interface WorkerDependencies {
  prisma: PrismaClient;
  objectStore: ObjectStore;
  transcriber: Transcriber;
  timeSource: TimeSource;
  /** A Worker issues blocking commands and cannot share the queue's. */
  connection: Redis;
  queueName: string;
}

/**
 * A vendor's own words, bounded.
 *
 * The message goes on screen beside the recording it is about, so it is the
 * vendor's sentence and not a paraphrase. Capped because nothing stops an HTTP
 * adapter throwing with a response body attached, and a megabyte of HTML in a
 * text column is not a reason anybody can read.
 */
function reasonFor(error: unknown): string {
  const said = error instanceof Error ? error.message : String(error);
  const trimmed = said.trim();
  return (trimmed === '' ? 'the transcription vendor gave no reason' : trimmed)
    .slice(0, 500);
}

export function buildWorker({
  prisma,
  objectStore,
  transcriber,
  timeSource,
  connection,
  queueName,
}: WorkerDependencies): Worker<TranscribeJob> {
  return new Worker<TranscribeJob>(
    queueName,
    async (job) => {
      const { voiceCaptureId } = job.data;
      const capture = await prisma.voiceCapture.findUnique({
        where: { id: voiceCaptureId },
        select: { id: true, storageKey: true, contentType: true },
      });
      if (capture === null) {
        return;
      }

      // Stamped before the vendor is called, and clearing any earlier failure
      // as it goes: this is what a retry looks like from here, and what the
      // progress stream reads as "still working".
      await prisma.voiceCapture.update({
        where: { id: capture.id },
        data: {
          transcribingSince: timeSource.now(),
          failedAt: null,
          failure: null,
        },
      });

      try {
        const audio = await objectStore.get(capture.storageKey);
        const transcript = await transcriber.transcribe(
          audio,
          capture.contentType,
        );
        // Compare-and-set, so a second job for the same recording writes
        // nothing. Two taps of "ask again" while it is queued enqueue two,
        // and the retry route's own refusal cannot see them coming — a
        // second transcript landing here would silently overwrite the words
        // the engineer is part-way through correcting, which is the thing
        // that refusal exists to prevent.
        await prisma.voiceCapture.updateMany({
          where: { id: capture.id, transcribedAt: null },
          data: { transcript, transcribedAt: timeSource.now() },
        });
      } catch (error) {
        // Recorded and **not** rethrown, so BullMQ does not retry it. A vendor
        // that rejected this audio will reject it again, and an attempt the
        // engineer did not ask for would move `transcribing_since` under the
        // screen they are reading. The audio is untouched in the store and
        // `POST /voice-captures/:id/retry` is the way back — which is the
        // ticket's "leaves the audio recoverable", made of parts that exist.
        await prisma.voiceCapture.update({
          where: { id: capture.id },
          data: { failedAt: timeSource.now(), failure: reasonFor(error) },
        });
      }
    },
    // One at a time. There is one engineer, one walk and one phone, and a
    // vendor charging per request is not somewhere to discover concurrency.
    { connection, concurrency: 1 },
  );
}
