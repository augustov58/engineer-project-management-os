/**
 * The worker: the two things in this product that run off the request —
 * transcription (issue #12) and rendering a site visit report (issue #13).
 *
 * BullMQ has been wired and idle since slice 1, and ADR-0032 deliberately kept
 * photo binning out of it — "date comparison and one regular expression". That
 * reasoning does not reach either of these. Asking a vendor what was said in
 * two minutes of audio is a network call of unbounded duration; printing a
 * walk's write-up starts a browser, decodes every photograph on it and lays
 * out a paginated document. Both tickets' progress criteria presuppose that
 * the request has long since returned.
 *
 * One queue and two job names, dispatched below. A second queue would be a
 * second thing to name, connect and close, for work the single concurrency
 * already serialises.
 *
 * It runs in the API's process. ADR-0012 makes this a single-user tool, one
 * process is one thing to start and stop, and `buildWorker` takes the same
 * injected dependencies `buildServer` does — so the test harness gets a real
 * worker over a real Redis the same way production does, rather than by a
 * second copy of the wiring staying in step. Splitting it into its own process
 * later is a deployment change and touches nothing above this file.
 */

import { randomUUID } from 'node:crypto';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { ObjectStore } from './object-store.js';
import { renderPdf } from './pdf.js';
import { composeReport } from './report.js';
import type { TimeSource } from './time-source.js';
import type { Transcriber } from './transcription.js';

/** Asking the vendor what was said (issue #12). */
export const TRANSCRIBE = 'transcribe';

/** Rendering a walk into the document it is written up as (issue #13). */
export const RENDER_REPORT = 'render-report';

/**
 * The id and nothing else. Everything the job needs is on the row, so a job
 * that sat in Redis across a restart cannot carry a stale copy of it.
 */
export interface TranscribeJob {
  voiceCaptureId: string;
}

/** The id and nothing else, for the reason above. */
export interface RenderReportJob {
  siteVisitReportId: string;
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
 * What went wrong, in its own words, bounded.
 *
 * The message goes on screen beside the recording or the report it is about,
 * so it is the vendor's sentence — or the renderer's — and not a paraphrase.
 * Capped because nothing stops an HTTP adapter throwing with a response body
 * attached, or a browser throwing with a stack, and a megabyte of either in a
 * text column is not a reason anybody can read.
 */
function reasonFor(error: unknown, silent: string): string {
  const said = error instanceof Error ? error.message : String(error);
  const trimmed = said.trim();
  return (trimmed === '' ? silent : trimmed).slice(0, 500);
}

export function buildWorker({
  prisma,
  objectStore,
  transcriber,
  timeSource,
  connection,
  queueName,
}: WorkerDependencies): Worker<TranscribeJob | RenderReportJob> {
  /** Asking the vendor what was said (issue #12). */
  const transcribe = async (voiceCaptureId: string) => {
    const capture = await prisma.voiceCapture.findUnique({
      where: { id: voiceCaptureId },
      select: {
        id: true,
        storageKey: true,
        contentType: true,
        transcribedAt: true,
      },
    });
    if (capture === null) {
      return;
    }
    if (capture.transcribedAt !== null) {
      // Already answered. Two taps of "ask again" while it is queued enqueue
      // two jobs, and BullMQ can redeliver a stalled one; the write below is
      // guarded either way, but a vendor is a paid network call and there is
      // nothing here left to ask it. Returning also leaves
      // `transcribing_since` where the answered attempt left it, rather than
      // moving it under a screen that is showing a finished transcript.
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
        data: {
          failedAt: timeSource.now(),
          failure: reasonFor(error, 'the transcription vendor gave no reason'),
        },
      });
    }
  };

  /**
   * Rendering a walk into its report (issue #13).
   *
   * The same shape as the transcription above, and for the same reasons: the
   * start is stamped before the slow thing runs so the progress stream has
   * something to say, and a failure is recorded rather than rethrown so BullMQ
   * does not retry an attempt nobody asked for.
   *
   * What differs is what a second attempt is. A recording is retried in place,
   * because its audio is irreplaceable and the phone has already let go of it;
   * a report's every input is still in the database, so generating again is
   * another row and this one keeps saying what happened to it. That is also
   * how a report is regenerated once a missing photograph has been added.
   */
  const renderReport = async (siteVisitReportId: string) => {
    const report = await prisma.siteVisitReport.findUnique({
      where: { id: siteVisitReportId },
      select: { id: true, siteVisitId: true, renderedAt: true },
    });
    if (report === null) {
      return;
    }
    if (report.renderedAt !== null) {
      // Already rendered. BullMQ can redeliver a stalled job, and printing the
      // walk a second time would cost a browser launch to produce a document
      // that is already stored — and would move `rendering_since` under a
      // screen showing a finished report.
      return;
    }

    await prisma.siteVisitReport.update({
      where: { id: report.id },
      data: { renderingSince: timeSource.now() },
    });

    try {
      const pdf = await renderPdf(
        await composeReport(prisma, objectStore, report.siteVisitId),
      );

      // Bytes first, then the row that points at them — ADR-0032's order, and
      // for its reason: `put` is a network write against the S3 adapter, and a
      // key stored ahead of the object would point at bytes that are not
      // there. An object nothing points at is garbage no reader reaches.
      const storageKey = `reports/${randomUUID()}`;
      await objectStore.put(storageKey, pdf, 'application/pdf');

      // Compare-and-set, so a redelivered job that got past the read above
      // writes nothing. `storage_key` is unique, and the loser's object is
      // then garbage rather than a second key on a row that has one.
      await prisma.siteVisitReport.updateMany({
        where: { id: report.id, renderedAt: null },
        data: { storageKey, byteSize: pdf.byteLength, renderedAt: timeSource.now() },
      });
    } catch (error) {
      await prisma.siteVisitReport.update({
        where: { id: report.id },
        data: {
          failedAt: timeSource.now(),
          failure: reasonFor(error, 'the renderer gave no reason'),
        },
      });
    }
  };

  return new Worker<TranscribeJob | RenderReportJob>(
    queueName,
    async (job) => {
      // Dispatched on the job's name, on the one queue. A second queue would
      // be a second thing to name, connect and close for work that is already
      // serialised by the concurrency below.
      if (job.name === RENDER_REPORT) {
        // Narrowed by the name, which is what BullMQ types cannot do across a
        // union of payloads.
        return renderReport((job.data as RenderReportJob).siteVisitReportId);
      }
      return transcribe((job.data as TranscribeJob).voiceCaptureId);
    },
    // One at a time. There is one engineer, one walk and one phone; a vendor
    // charging per request is not somewhere to discover concurrency, and two
    // browsers printing at once on the same machine is not either.
    { connection, concurrency: 1 },
  );
}
