/**
 * The worker: the six things in this product that run off the request —
 * transcription (issue #12), rendering a site visit report (issue #13), an
 * agent run proposing a memory edit (issue #18), an extraction run over an
 * untrusted source (issue #20), an agent run proposing the draft a typed
 * capture becomes (issue #114), and the project chat's run (issue #121).
 *
 * BullMQ has been wired and idle since slice 1, and ADR-0032 deliberately kept
 * photo binning out of it — "date comparison and one regular expression". That
 * reasoning does not reach any of these. Asking a vendor what was said in
 * two minutes of audio is a network call of unbounded duration; printing a
 * walk's write-up starts a browser, decodes every photograph on it and lays
 * out a paginated document; an extraction is an OCR call and a paid model
 * call, back to back; a capture proposal is a paid model call made while the
 * engineer is still walking; and the project chat's run is a paid model call
 * that may run three helper subprocesses on the way. All six tickets' progress
 * criteria presuppose that the request has long since returned.
 *
 * One queue and six job names, dispatched below. A second queue would be a
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
import type { AgentRunService, ExtractionSourcePacket } from './agent.js';
import { underRunSession } from './gate.js';
import type { ObjectStore } from './object-store.js';
import { PROCESSING_LOCATION_IS_LOCAL } from './refusals.js';
import type { OcrProvider } from './ocr.js';
import { renderPdf } from './pdf.js';
import { composeReport } from './report.js';
import type { TimeSource } from './time-source.js';
import type { Transcriber } from './transcription.js';

/** Asking the vendor what was said (issue #12). */
export const TRANSCRIBE = 'transcribe';

/** Rendering a walk into the document it is written up as (issue #13). */
export const RENDER_REPORT = 'render-report';

/** Asking the agent to propose an edit to a project's memory (issue #18). */
export const PROPOSE_MEMORY_EDIT = 'propose-memory-edit';

/**
 * Reading one untrusted source into a proposed register entry (issue #20):
 * the OCR call and the agent run, back to back.
 */
export const EXTRACT = 'extract';

/**
 * Asking the agent to propose the draft a typed capture becomes (issue #114).
 *
 * A fifth name on the one queue and **not** a fifth record: the run is a row in
 * `agent_runs`, as a memory run is, and what tells the two apart is the
 * conversation it points at (ADR-0058).
 */
export const PROPOSE_CAPTURE = 'propose-capture';

/**
 * Asking the agent to answer on a project's conversation (issue #121).
 *
 * A sixth name on the one queue and **not** a sixth record: the run is a row in
 * `agent_runs` like the two above it, and what tells it from a capture run is
 * the conversation it points at having no site visit. The name is the
 * enqueuer's answer to which run this is, and the enqueuer is the route that
 * wrote the turn — so a job cannot be dispatched against the wrong kind of
 * conversation by a read going stale.
 */
export const PROPOSE_ASSUMPTION_RECORD = 'propose-assumption-record';

/**
 * The most OCR text one extraction run hands the model, in characters (issue
 * #132, ADR-0063). Past it the row fails with `tooLargeToExtract` and the
 * agent is never called — refused, never truncated, ADR-0042's rule for a
 * sender's body out of ADR-0039's base64 lesson. `ocr_text` is still stored
 * whole first (ADR-0043).
 *
 * Derived, not chosen. The model `AGENT=pi` resolves to on `epmos-t1` is
 * `kimi-coding/kimi-for-coding`: a 262,144-token window and 32,768 tokens of
 * output. A run is at least two model calls — the proposal is a tool call and
 * its result goes back — so two outputs are reserved: 196,608 tokens left.
 * The rest of the packet is 269,814 characters at its bounds (the prompt with
 * the envelope's body, sender and subject and the filename at their maximums,
 * the one tool's schema, the SDK's system prompt), which at Kimi's documented
 * low end of three characters a token is 89,938. That leaves 106,670 tokens,
 * 320,010 characters, rounded down so the margin carries the tool call and its
 * answer. The one real document measured was 56,236 characters (2026-09-15).
 * No model is pinned in this repository: a smaller window on the machine is
 * the trigger to derive this again.
 *
 * What it bounds is the vendor: Azure Document Intelligence S0 accepts 2,000
 * pages or 500 MB (ADR-0060), which is millions of characters. This product's
 * own document boundary is 48 MiB of file, which bounds bytes and not text.
 */
export const EXTRACTION_TEXT_MAX = 300_000;

/** Why an extraction past the bound failed, with how far past it was. */
export function tooLargeToExtract(length: number): string {
  return `the document is too large to extract: its text is ${length.toLocaleString('en-US')} characters and one run reads at most ${EXTRACTION_TEXT_MAX.toLocaleString('en-US')}`;
}

/**
 * The id and nothing else. Everything the job needs is on the row, so a job
 * that sat in Redis across a restart cannot carry a stale copy of it.
 */
export interface TranscribeJob {
  turnId: string;
}

/** The id and nothing else, for the reason above. */
export interface RenderReportJob {
  siteVisitReportId: string;
}

/** The id and nothing else, for the reason above. */
export interface ProposeMemoryEditJob {
  agentRunId: string;
}

/** The id and nothing else, for the reason above. */
export interface ExtractJob {
  extractionId: string;
}

/** The id and nothing else, for the reason above. */
export interface ProposeCaptureJob {
  agentRunId: string;
}

/** The id and nothing else, for the reason above. */
export interface ProposeAssumptionRecordJob {
  agentRunId: string;
}

export interface WorkerDependencies {
  prisma: PrismaClient;
  objectStore: ObjectStore;
  transcriber: Transcriber;
  agentRunService: AgentRunService;
  ocr: OcrProvider;
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
  agentRunService,
  ocr,
  timeSource,
  connection,
  queueName,
}: WorkerDependencies): Worker<
  | TranscribeJob
  | RenderReportJob
  | ProposeMemoryEditJob
  | ExtractJob
  | ProposeCaptureJob
  | ProposeAssumptionRecordJob
> {
  /** Asking the vendor what was said (issue #12). */
  const transcribe = async (turnId: string) => {
    const capture = await prisma.turn.findUnique({
      where: { id: turnId },
      select: {
        id: true,
        storageKey: true,
        contentType: true,
        transcribedAt: true,
      },
    });
    if (capture === null || capture.storageKey === null || capture.contentType === null) {
      // No row, or a turn with no recording — a typed capture or the agent's
      // reply. Neither is a job this product enqueues, so reaching here is a
      // job that outlived its reason rather than work to do.
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
    await prisma.turn.update({
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
      await prisma.turn.updateMany({
        where: { id: capture.id, transcribedAt: null },
        data: { transcript, transcribedAt: timeSource.now() },
      });
    } catch (error) {
      // Recorded and **not** rethrown, so BullMQ does not retry it. A vendor
      // that rejected this audio will reject it again, and an attempt the
      // engineer did not ask for would move `transcribing_since` under the
      // screen they are reading. The audio is untouched in the store and
      // `POST /turns/:id/retry` is the way back — which is the
      // ticket's "leaves the audio recoverable", made of parts that exist.
      await prisma.turn.update({
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

    // Read once and used twice: the row says the rendering started here and
    // the document's running footer prints the same instant (issue #119), so
    // the record and the page it is a record of cannot disagree about when.
    const renderingSince = timeSource.now();
    await prisma.siteVisitReport.update({
      where: { id: report.id },
      data: { renderingSince },
    });

    try {
      const pdf = await renderPdf(
        await composeReport(
          prisma,
          objectStore,
          report.siteVisitId,
          renderingSince,
        ),
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

  /**
   * Asking the agent to propose a memory edit (issue #18).
   *
   * The same shape as the two above, and the report's answer to what a second
   * attempt is: a run's every input is still in the database, so asking again
   * is another row and this one keeps saying what happened to it — which is
   * why there is no retry route. The proposal, if one comes, arrives during
   * the run through the agent's own tool calling the internal API; what is
   * stamped here is only that the run started and how it ended.
   */
  const proposeMemoryEdit = async (agentRunId: string) => {
    const run = await prisma.agentRun.findUnique({
      where: { id: agentRunId },
      select: {
        id: true,
        projectId: true,
        finishedAt: true,
        failedAt: true,
      },
    });
    if (run === null) {
      return;
    }
    if (run.finishedAt !== null || run.failedAt !== null) {
      // Already settled. BullMQ can redeliver a stalled job, and a second
      // attempt would ask a paid model again to produce a proposal the unique
      // `run_id` would refuse — so there is nothing here left to do.
      return;
    }

    await prisma.agentRun.update({
      where: { id: run.id },
      data: { runningSince: timeSource.now() },
    });

    try {
      // Under the session the route minted beside this run, in the name of
      // whoever asked for it: the agent's tools present it at the gate like
      // any other caller, and it is revoked the moment this returns either way
      // (issue #105, ADR-0055).
      await underRunSession(
        prisma,
        { agentRunId: run.id },
        timeSource,
        (sessionId) =>
          agentRunService.proposeMemoryEdit({
            runId: run.id,
            projectId: run.projectId,
            sessionId,
          }),
      );
      // Compare-and-set, so a redelivered job that got past the read above
      // writes nothing.
      await prisma.agentRun.updateMany({
        where: { id: run.id, finishedAt: null, failedAt: null },
        data: { finishedAt: timeSource.now() },
      });
    } catch (error) {
      // Recorded and not rethrown, as a transcription failure is: a model
      // that refused this run will refuse it again, and an attempt the
      // engineer did not ask for would move `running_since` under the screen
      // they are reading. Asking again is another run row.
      await prisma.agentRun.updateMany({
        where: { id: run.id, finishedAt: null, failedAt: null },
        data: {
          failedAt: timeSource.now(),
          failure: reasonFor(error, 'the agent run service gave no reason'),
        },
      });
    }
  };

  /**
   * A run held on a conversation, with the conversation as it stands now.
   *
   * Read **here and not carried on the job**, so a run answers the words as
   * they stand when it runs rather than as they stood when it was asked for —
   * which is what makes the engineer's answer to the agent's question reach the
   * next run at all. Both runs on a conversation read it through this one
   * function, so the two cannot come to disagree about what a turn is.
   */
  const runOnAConversation = (agentRunId: string) =>
    prisma.agentRun.findUnique({
      where: { id: agentRunId },
      select: {
        id: true,
        projectId: true,
        finishedAt: true,
        failedAt: true,
        conversation: {
          select: {
            id: true,
            siteVisitId: true,
            turns: {
              orderBy: { position: 'asc' },
              select: { speaker: true, transcript: true },
            },
          },
        },
      },
    });

  /**
   * What was said, in order — and nothing that was not said.
   *
   * A turn with no words is the agent's own proposal of fields, which is on the
   * record already and is not something to read back to it as though it had
   * been said.
   */
  const said = (turns: { speaker: string; transcript: string | null }[]) => ({
    turns: turns.flatMap((turn) =>
      turn.transcript === null
        ? []
        : [
            {
              speaker:
                turn.speaker === 'AGENT'
                  ? ('agent' as const)
                  : ('engineer' as const),
              words: turn.transcript,
            },
          ],
    ),
  });

  /**
   * Asking the agent to propose the draft a typed capture becomes (issue #114).
   *
   * The memory run's shape exactly — the row is the record, the job carries the
   * id, the start is stamped, and a failure is recorded rather than rethrown so
   * BullMQ does not retry an attempt nobody asked for. Asking again is another
   * typed turn, which is the same answer a memory run gives and for the same
   * reason: every input is still in the database.
   *
   * What differs is the packet. The conversation is read **here and not carried
   * on the job**, so the run answers the words as they stand when it runs
   * rather than as they stood when it was asked for — which is what makes the
   * engineer's answer to the agent's question reach the next run at all.
   */
  const proposeCapture = async (agentRunId: string) => {
    const run = await runOnAConversation(agentRunId);
    if (run === null || run.conversation === null) {
      return;
    }
    if (run.finishedAt !== null || run.failedAt !== null) {
      // Already settled, as a memory run is: a second attempt would ask a paid
      // model again to produce a turn the unique `agent_run_id` would refuse.
      return;
    }

    await prisma.agentRun.update({
      where: { id: run.id },
      data: { runningSince: timeSource.now() },
    });

    try {
      const siteVisitId = run.conversation.siteVisitId;
      if (siteVisitId === null) {
        // A project conversation, which has no walk to read and no
        // `capture_propose` to call. Since issue #121 it has a run of its own
        // and a job name of its own, so reaching here is a job dispatched
        // against the wrong kind of conversation rather than work to do.
        throw new Error('that conversation is not on a site visit');
      }

      await underRunSession(
        prisma,
        { agentRunId: run.id },
        timeSource,
        (sessionId) =>
          agentRunService.proposeCapture({
            runId: run.id,
            projectId: run.projectId,
            siteVisitId,
            conversation: said(run.conversation!.turns),
            sessionId,
          }),
      );
      // Compare-and-set, so a redelivered job that got past the read above
      // writes nothing.
      await prisma.agentRun.updateMany({
        where: { id: run.id, finishedAt: null, failedAt: null },
        data: { finishedAt: timeSource.now() },
      });
    } catch (error) {
      await prisma.agentRun.updateMany({
        where: { id: run.id, finishedAt: null, failedAt: null },
        data: {
          failedAt: timeSource.now(),
          failure: reasonFor(error, 'the agent run service gave no reason'),
        },
      });
    }
  };

  /**
   * Asking the agent to answer on a project's conversation (issue #121).
   *
   * The capture run's shape with the walk taken out, and the same answers to
   * the same questions: the row is the record, the job carries the id, the
   * start is stamped, a failure is recorded rather than rethrown, and asking
   * again is another typed turn rather than a retry.
   *
   * A run that answers nothing is a **finished** run with no turn on the
   * conversation, as a capture run is — the panel reads the run's state and
   * never the absence of a reply.
   */
  const proposeAssumptionRecord = async (agentRunId: string) => {
    const run = await runOnAConversation(agentRunId);
    if (run === null || run.conversation === null) {
      return;
    }
    if (run.finishedAt !== null || run.failedAt !== null) {
      return;
    }

    await prisma.agentRun.update({
      where: { id: run.id },
      data: { runningSince: timeSource.now() },
    });

    try {
      if (run.conversation.siteVisitId !== null) {
        // A walk's conversation, whose run is `propose-capture` and whose tools
        // are the walk's three. Reaching here is a job dispatched against the
        // wrong kind of conversation, and it fails honestly rather than giving
        // a walk the helpers.
        throw new Error('that conversation is on a site visit');
      }

      await underRunSession(
        prisma,
        { agentRunId: run.id },
        timeSource,
        (sessionId) =>
          agentRunService.proposeAssumptionRecord({
            runId: run.id,
            projectId: run.projectId,
            conversation: said(run.conversation!.turns),
            sessionId,
          }),
      );
      // Compare-and-set, so a redelivered job that got past the read above
      // writes nothing.
      await prisma.agentRun.updateMany({
        where: { id: run.id, finishedAt: null, failedAt: null },
        data: { finishedAt: timeSource.now() },
      });
    } catch (error) {
      await prisma.agentRun.updateMany({
        where: { id: run.id, finishedAt: null, failedAt: null },
        data: {
          failedAt: timeSource.now(),
          failure: reasonFor(error, 'the agent run service gave no reason'),
        },
      });
    }
  };

  /**
   * Reading one untrusted source into a proposed register entry (issue #20).
   *
   * The same shape as the memory run above, with one step in front of it:
   * the OCR port turns the source's bytes into text, the text is stored on
   * the row — ADR-0008's "OCR output stored for audit" and the confirmation
   * screen's subject — and only then is the agent called. That ordering is
   * what keeps the consent gate: with no OCR adapter written, no document's
   * content reaches the model provider, because there is no text to hand it
   * (ADR-0043).
   *
   * The proposal, if one comes, arrives during the run through the agent's
   * own tool calling the internal API. A run that proposes nothing is
   * finished, not failed: "no correspondence here" is an answer.
   */
  const extract = async (extractionId: string) => {
    const extraction = await prisma.registerEntryExtraction.findUnique({
      where: { id: extractionId },
      select: {
        id: true,
        projectId: true,
        finishedAt: true,
        failedAt: true,
        // Read here and not carried on the job, so the value is the one that
        // holds when the run happens rather than when it was asked for.
        project: { select: { processingLocation: true } },
        ingestedDocumentFile: {
          select: {
            filename: true,
            contentType: true,
            storageKey: true,
            ingestedDocument: {
              select: { sender: true, subject: true, body: true },
            },
          },
        },
        documentVersion: {
          select: { filename: true, contentType: true, storageKey: true },
        },
      },
    });
    if (extraction === null) {
      return;
    }
    if (extraction.finishedAt !== null || extraction.failedAt !== null) {
      // Already settled. BullMQ can redeliver a stalled job, and a second
      // attempt would ask two paid vendors again — so there is nothing here
      // left to do.
      return;
    }

    await prisma.registerEntryExtraction.update({
      where: { id: extraction.id },
      data: { runningSince: timeSource.now() },
    });

    try {
      // The half of the gate that is a bound (issue #21, ADR-0044). The create
      // routes refuse the ask, but a job enqueued while the project was on
      // cloud is already in Redis when the engineer switches it to local, and
      // that is precisely the moment consent has been withdrawn. Checked
      // before the bytes are even fetched, so nothing about the document is
      // read; the failure lands on the row through the catch below, saying
      // what a refusing OCR default would say — honestly, and in the same
      // sentence the route used.
      if (extraction.project.processingLocation === 'LOCAL') {
        throw new Error(PROCESSING_LOCATION_IS_LOCAL);
      }

      const sourceFile =
        extraction.ingestedDocumentFile ?? extraction.documentVersion;
      if (sourceFile === null) {
        // The CHECK says exactly one is set, so reaching this is corruption,
        // not input. Failed with the fact, not a crash.
        throw new Error('the extraction names no source');
      }

      const bytes = await objectStore.get(sourceFile.storageKey);
      const text = await ocr.read(
        bytes,
        sourceFile.contentType,
        sourceFile.filename,
      );
      // Stored before the agent is called, so a run the model failed still
      // leaves what the OCR step read. A job redelivered while the first
      // attempt is mid-run does call both vendors again — the read above only
      // refuses a settled row — and that re-run is the only recovery path a
      // crashed worker has, since there is no retry route. The compare-and-set
      // below is what keeps two attempts from both finishing the row.
      await prisma.registerEntryExtraction.update({
        where: { id: extraction.id },
        data: { ocrText: text },
      });
      // After the store and before the packet, so a document too large to
      // read fails here with what the vendor read kept, rather than late at
      // the model provider after its input has been paid for.
      if (text.length > EXTRACTION_TEXT_MAX) {
        throw new Error(tooLargeToExtract(text.length));
      }

      const source: ExtractionSourcePacket = {
        filename: sourceFile.filename,
        contentType: sourceFile.contentType,
        ...(extraction.ingestedDocumentFile === null
          ? {}
          : {
              envelope: {
                sender: extraction.ingestedDocumentFile.ingestedDocument.sender,
                subject:
                  extraction.ingestedDocumentFile.ingestedDocument.subject,
                body: extraction.ingestedDocumentFile.ingestedDocument.body,
              },
            }),
        text,
      };
      // Under this run's own session, as the memory run above is.
      await underRunSession(
        prisma,
        { extractionId: extraction.id },
        timeSource,
        (sessionId) =>
          agentRunService.extractRegisterEntry({
            extractionId: extraction.id,
            projectId: extraction.projectId,
            source,
            sessionId,
          }),
      );
      // Compare-and-set, so a redelivered job that got past the read above
      // writes nothing.
      await prisma.registerEntryExtraction.updateMany({
        where: { id: extraction.id, finishedAt: null, failedAt: null },
        data: { finishedAt: timeSource.now() },
      });
    } catch (error) {
      // Recorded and not rethrown, as a transcription failure is: a vendor
      // that refused this document will refuse it again, and asking again is
      // another row — there is no retry route.
      await prisma.registerEntryExtraction.updateMany({
        where: { id: extraction.id, finishedAt: null, failedAt: null },
        data: {
          failedAt: timeSource.now(),
          failure: reasonFor(error, 'the extraction gave no reason'),
        },
      });
    }
  };

  return new Worker<
    | TranscribeJob
    | RenderReportJob
    | ProposeMemoryEditJob
    | ExtractJob
    | ProposeCaptureJob
  >(
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
      if (job.name === PROPOSE_MEMORY_EDIT) {
        return proposeMemoryEdit(
          (job.data as ProposeMemoryEditJob).agentRunId,
        );
      }
      if (job.name === EXTRACT) {
        return extract((job.data as ExtractJob).extractionId);
      }
      if (job.name === PROPOSE_CAPTURE) {
        return proposeCapture((job.data as ProposeCaptureJob).agentRunId);
      }
      if (job.name === PROPOSE_ASSUMPTION_RECORD) {
        return proposeAssumptionRecord(
          (job.data as ProposeAssumptionRecordJob).agentRunId,
        );
      }
      return transcribe((job.data as TranscribeJob).turnId);
    },
    // One at a time. There is one engineer, one walk and one phone; a vendor
    // charging per request is not somewhere to discover concurrency, and two
    // browsers printing at once on the same machine is not either.
    { connection, concurrency: 1 },
  );
}
