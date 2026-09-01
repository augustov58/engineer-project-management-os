/**
 * Extractions: reading one untrusted source into a proposed register entry,
 * and the engineer's confirmation or rejection of that proposal (issue #20,
 * stories 84-90; ADR-0043).
 *
 * An extraction is one record that runs, proposes and resolves. The run is a
 * row first and a job second — the screen watches the row over SSE, and the
 * job carries the id and nothing else. Nothing the agent produces commits:
 * the proposal is fields on the row, and confirming is a separate call that
 * writes the document, the entry and its first handoff in one transaction.
 */

import type { FastifyInstance } from 'fastify';
import { Prisma } from '../../generated/prisma/client.js';
import { NOT_BLANK, violates, type RouteDependencies } from '../http.js';
import { noSuchExtraction, noSuchProject, refuse } from '../refusals.js';
import { progressStreams } from '../stream.js';
import { EXTRACT, type ExtractJob } from '../worker.js';
import { DOCUMENT_CONTENT_TYPES } from './documents.js';
import { handoffBodySchema, handoffData, TURNAROUND_DAYS } from './registers.js';

/** This record's own 404, which nothing else sends (ADR-0033). */
const NO_SUCH_FILE = {
  code: 404,
  message: 'no ingested document file with that id',
} as const;

/**
 * The typed shape the agent's output is constrained to, and the same shape
 * the engineer edits at confirmation — one schema for both, so the boundary
 * the agent is held to and the boundary the engineer is held to cannot drift
 * apart.
 *
 * Every field is the register entry's own, with its own bounds, plus the
 * document's `title` and `revision` on the arrival path — the two fields
 * ADR-0042 named as extraction's to propose. `additionalProperties: false`
 * and the ajv setting at the boundary are what "agent output is rejected if
 * it is not the typed shape" is made of: a field the schema does not name is
 * a 400, not a stripped key.
 */
const fieldsBodySchema = {
  type: 'object',
  required: ['kind', 'number', 'subject', 'fromParty', 'toParty', 'ballInCourt'],
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['SUBMITTAL', 'RFI'] },
    number: { type: 'string', pattern: NOT_BLANK, maxLength: 32 },
    subject: { type: 'string', pattern: NOT_BLANK, maxLength: 200 },
    fromParty: { type: 'string', pattern: NOT_BLANK, maxLength: 120 },
    toParty: { type: 'string', pattern: NOT_BLANK, maxLength: 120 },
    question: { type: 'string', pattern: NOT_BLANK, maxLength: 2000 },
    response: { type: 'string', pattern: NOT_BLANK, maxLength: 2000 },
    turnaroundDays: TURNAROUND_DAYS,
    ballInCourt: handoffBodySchema,
    title: { type: 'string', pattern: NOT_BLANK, maxLength: 200 },
    revision: { type: 'string', pattern: NOT_BLANK, maxLength: 32 },
  },
} as const;

interface FieldsBody {
  kind: 'SUBMITTAL' | 'RFI';
  number: string;
  subject: string;
  fromParty: string;
  toParty: string;
  question?: string;
  response?: string;
  turnaroundDays?: number;
  ballInCourt: { party: string; inOurCourt: boolean; heldSince?: string };
  title?: string;
  revision?: string;
}

/**
 * What an extraction is read with: the source it ran over, so a list can name
 * it. Relations are nested selects rather than an `include`, because Prisma
 * takes one or the other; the source's `storage_key` never leaves the
 * database, here as everywhere else.
 */
const extractionSelect = {
  id: true,
  projectId: true,
  ingestedDocumentFileId: true,
  documentVersionId: true,
  runningSince: true,
  finishedAt: true,
  failedAt: true,
  failure: true,
  proposedKind: true,
  proposedAt: true,
  proposedNumber: true,
  proposedSubject: true,
  proposedFromParty: true,
  proposedToParty: true,
  proposedQuestion: true,
  proposedResponse: true,
  proposedTurnaroundDays: true,
  proposedParty: true,
  proposedInOurCourt: true,
  proposedHeldSince: true,
  proposedTitle: true,
  proposedRevision: true,
  confirmedAt: true,
  registerEntryId: true,
  rejectedAt: true,
  createdAt: true,
  ingestedDocumentFile: {
    select: {
      filename: true,
      ingestedDocumentId: true,
      ingestedDocument: {
        select: { sender: true, subject: true, body: true },
      },
    },
  },
  documentVersion: {
    select: {
      filename: true,
      document: { select: { id: true, title: true } },
    },
  },
} satisfies Prisma.RegisterEntryExtractionSelect;

type StoredExtraction = Prisma.RegisterEntryExtractionGetPayload<{
  select: typeof extractionSelect;
}>;

/**
 * The state, derived on every read from the stamps — there is no status
 * column, the fifth record to refuse one (ADR-0024, ADR-0031, ADR-0034,
 * ADR-0035). *Finished* is the honest "the agent found no correspondence
 * here": the run ended and proposed nothing.
 */
function stateOf(extraction: {
  confirmedAt: Date | null;
  rejectedAt: Date | null;
  proposedAt: Date | null;
  failedAt: Date | null;
  finishedAt: Date | null;
  runningSince: Date | null;
}) {
  if (extraction.confirmedAt !== null) {
    return 'confirmed';
  }
  if (extraction.rejectedAt !== null) {
    return 'rejected';
  }
  if (extraction.proposedAt !== null) {
    return 'pending';
  }
  if (extraction.failedAt !== null) {
    return 'failed';
  }
  if (extraction.finishedAt !== null) {
    return 'finished';
  }
  return extraction.runningSince === null ? 'queued' : 'running';
}

/**
 * An extraction on the wire: its state derived, and its source named by
 * filename rather than by a key. The arrival's envelope rides on the source
 * so the confirmation screen can show what the agent was handed.
 */
function extractionOnTheWire(extraction: StoredExtraction) {
  const { ingestedDocumentFile, documentVersion, ...rest } = extraction;
  const source =
    ingestedDocumentFile !== null
      ? {
          filename: ingestedDocumentFile.filename,
          envelope: {
            sender: ingestedDocumentFile.ingestedDocument.sender,
            subject: ingestedDocumentFile.ingestedDocument.subject,
            body: ingestedDocumentFile.ingestedDocument.body,
          },
        }
      : {
          filename: documentVersion!.filename,
          document: documentVersion!.document,
        };
  return { ...rest, source, state: stateOf(extraction) };
}

/** A file or document already has a run in flight or a proposal awaiting the engineer. */
const inFlightWhere: Prisma.RegisterEntryExtractionWhereInput = {
  confirmedAt: null,
  rejectedAt: null,
  failedAt: null,
  OR: [{ finishedAt: null }, { proposedAt: { not: null } }],
};

/**
 * Which of the two paths a body is on, enforced where the record's own rules
 * live. A stored document already has a title and a revision; an arrival has
 * neither and the confirmation is what supplies them (ADR-0042).
 */
function titleRevisionRefusal(
  arrivalPath: boolean,
  body: FieldsBody,
): { code: number; message: string } | null {
  if (arrivalPath && (body.title === undefined || body.revision === undefined)) {
    return {
      code: 409,
      message: 'an extraction of an arrival needs a title and a revision',
    };
  }
  if (!arrivalPath && (body.title !== undefined || body.revision !== undefined)) {
    return {
      code: 409,
      message: 'a stored document already has a title and a revision',
    };
  }
  return null;
}

/**
 * The register's own rules, restated at this boundary because the
 * confirmation is a second writer of the entry table: an RFI is a question,
 * and a submittal carries neither a question nor a response.
 */
function questionRefusal(body: FieldsBody): { code: number; message: string } | null {
  if (body.kind === 'RFI' && body.question === undefined) {
    return { code: 409, message: 'an RFI needs a question' };
  }
  if (body.kind === 'SUBMITTAL' && body.question !== undefined) {
    return { code: 409, message: 'a submittal has no question' };
  }
  if (body.kind === 'SUBMITTAL' && body.response !== undefined) {
    return { code: 409, message: 'a submittal has no response' };
  }
  return null;
}

/** Thrown inside the confirm transaction to roll it back as a 409. */
class AlreadyResolved extends Error {}

export function extractionRoutes(
  v1: FastifyInstance,
  { prisma, queue, timeSource }: RouteDependencies,
): void {
  const stream = progressStreams(v1);

  /**
   * Asking for an extraction over one file of an arrival (story 84).
   *
   * Manual and per file, which narrows the story's "automatically": the
   * engineer picks which file of an arrival is the correspondence, and an
   * automatic run would spend a vendor call on every arrival before anybody
   * had looked at it (ADR-0043). The row comes first and the job second, so
   * the screen has something to watch.
   */
  v1.post<{ Params: { id: string } }>(
    '/ingested-document-files/:id/extractions',
    async (request, reply) => {
      const file = await prisma.ingestedDocumentFile.findUnique({
        where: { id: request.params.id },
        select: {
          id: true,
          ingestedDocument: { select: { projectId: true } },
        },
      });
      if (file === null) {
        return refuse(reply, NO_SUCH_FILE);
      }

      const inFlight = await prisma.registerEntryExtraction.findFirst({
        where: { ingestedDocumentFileId: file.id, ...inFlightWhere },
        select: { id: true },
      });
      if (inFlight !== null) {
        return reply
          .code(409)
          .send({ message: 'an extraction of that file is already in flight' });
      }

      const extraction = await prisma.registerEntryExtraction.create({
        data: {
          projectId: file.ingestedDocument.projectId,
          ingestedDocumentFileId: file.id,
          createdAt: timeSource.now(),
        },
        select: extractionSelect,
      });
      await queue.add(EXTRACT, {
        extractionId: extraction.id,
      } satisfies ExtractJob);
      return reply.code(201).send(extractionOnTheWire(extraction));
    },
  );

  /**
   * Asking for an extraction over a stored document's latest version.
   *
   * The enqueuer ADR-0042 promised, reading the one predicate
   * `GET /projects/:id/extraction-targets` holds: a referenced file is
   * refused, so "a referenced file is never enqueued" is true at the write
   * as well as at the read. The version is resolved now and stamped, because
   * a version is immutable and the row records what was read — a later
   * revision cannot move the record underneath it (ADR-0039's reason).
   */
  v1.post<{ Params: { id: string } }>(
    '/documents/:id/extractions',
    async (request, reply) => {
      const document = await prisma.document.findUnique({
        where: { id: request.params.id },
        select: { id: true, projectId: true, referencedFile: true },
      });
      if (document === null) {
        return reply.code(404).send({ message: 'no document with that id' });
      }
      if (document.referencedFile) {
        return reply
          .code(409)
          .send({ message: 'a referenced file is not an extraction target' });
      }

      const version = await prisma.documentVersion.findFirst({
        where: { documentId: document.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      if (version === null) {
        return reply
          .code(409)
          .send({ message: 'that document has no versions' });
      }

      const inFlight = await prisma.registerEntryExtraction.findFirst({
        where: {
          documentVersion: { documentId: document.id },
          ...inFlightWhere,
        },
        select: { id: true },
      });
      if (inFlight !== null) {
        return reply.code(409).send({
          message: 'an extraction of that document is already in flight',
        });
      }

      const extraction = await prisma.registerEntryExtraction.create({
        data: {
          projectId: document.projectId,
          documentVersionId: version.id,
          createdAt: timeSource.now(),
        },
        select: extractionSelect,
      });
      await queue.add(EXTRACT, {
        extractionId: extraction.id,
      } satisfies ExtractJob);
      return reply.code(201).send(extractionOnTheWire(extraction));
    },
  );

  /** This job's extractions, oldest first, with each one's state derived. */
  v1.get<{ Params: { id: string } }>(
    '/projects/:id/extractions',
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }
      const extractions = await prisma.registerEntryExtraction.findMany({
        where: { projectId: project.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: extractionSelect,
      });
      return extractions.map(extractionOnTheWire);
    },
  );

  /**
   * One extraction, for the confirmation screen: the whole record plus the
   * OCR text the agent read, which is what the review is against (ADR-0043).
   */
  v1.get<{ Params: { id: string } }>(
    '/extractions/:id',
    async (request, reply) => {
      const extraction = await prisma.registerEntryExtraction.findUnique({
        where: { id: request.params.id },
        select: { ...extractionSelect, ocrText: true },
      });
      if (extraction === null) {
        return noSuchExtraction(reply);
      }
      return extractionOnTheWire(extraction);
    },
  );

  /**
   * The agent's one mutating tool lands here (story 85).
   *
   * What it writes is a **proposal**: fields on the extraction's own row,
   * which commit nothing. The register entry is written only by the confirm
   * route, which the agent has no tool for — so "no record exists in the
   * register until confirmation" is true by there being no path, not by a
   * guard.
   *
   * The proposal lands only during the run: a run that has not been picked
   * up, has finished, or has failed is refused, and a run proposes at most
   * once.
   */
  v1.post<{ Params: { id: string }; Body: FieldsBody }>(
    '/extractions/:id/proposal',
    { schema: { body: fieldsBodySchema } },
    async (request, reply) => {
      const extraction = await prisma.registerEntryExtraction.findUnique({
        where: { id: request.params.id },
        select: {
          id: true,
          ingestedDocumentFileId: true,
          runningSince: true,
          finishedAt: true,
          failedAt: true,
          proposedAt: true,
        },
      });
      if (extraction === null) {
        return noSuchExtraction(reply);
      }
      if (extraction.proposedAt !== null) {
        return reply
          .code(409)
          .send({ message: 'that extraction has already proposed' });
      }
      if (
        extraction.runningSince === null ||
        extraction.finishedAt !== null ||
        extraction.failedAt !== null
      ) {
        return reply
          .code(409)
          .send({ message: 'that extraction is not running' });
      }

      const refusal = titleRevisionRefusal(
        extraction.ingestedDocumentFileId !== null,
        request.body,
      );
      if (refusal !== null) {
        return refuse(reply, refusal);
      }

      const { kind, ballInCourt, question, response, turnaroundDays, title, revision, ...rest } =
        request.body;
      // Compare-and-set, so a second proposal racing the first writes
      // nothing: the run's stamps and `proposed_at` are read in one
      // statement with the write.
      const written = await prisma.registerEntryExtraction.updateMany({
        where: {
          id: extraction.id,
          proposedAt: null,
          runningSince: { not: null },
          finishedAt: null,
          failedAt: null,
        },
        data: {
          proposedAt: timeSource.now(),
          proposedKind: kind,
          ...mapRest(rest),
          proposedQuestion: question ?? null,
          proposedResponse: response ?? null,
          proposedTurnaroundDays: turnaroundDays ?? null,
          proposedParty: ballInCourt.party,
          proposedInOurCourt: ballInCourt.inOurCourt,
          proposedHeldSince:
            ballInCourt.heldSince === undefined
              ? null
              : new Date(ballInCourt.heldSince),
          proposedTitle: title ?? null,
          proposedRevision: revision ?? null,
        },
      });
      if (written.count === 0) {
        return reply
          .code(409)
          .send({ message: 'that extraction is not running' });
      }

      const updated = await prisma.registerEntryExtraction.findUniqueOrThrow({
        where: { id: extraction.id },
        select: extractionSelect,
      });
      return reply.code(201).send(extractionOnTheWire(updated));
    },
  );

  /**
   * Confirming a proposal — as proposed, or edited first (stories 86, 87).
   *
   * This is the only route that turns an extraction into records, and it
   * writes them in **one transaction**: on the arrival path the document and
   * its first version — ADR-0042's "confirmation is what turns one into a
   * document", kept — then the register entry **with its first handoff in
   * the same call** (ADR-0036's shape, which is what "can immediately run a
   * clock" is made of), then the `register_entry_document_versions` link to
   * the source, and finally this row's own stamps by compare-and-set, so a
   * double confirmation rolls back and refuses.
   *
   * The version **reuses the arrival file's storage key**: the bytes are
   * already in the store, nothing deletes either record, and a copy would be
   * a second object nobody reads.
   *
   * `referenced_file` is written `false` and is not asked: this flow exists
   * for correspondence, and the answer is what the act of extracting it for
   * a register entry already says. A drawing set that arrived by mail is
   * rejected here and stored through the referenced-file route.
   */
  v1.post<{ Params: { id: string }; Body: FieldsBody }>(
    '/extractions/:id/confirm',
    { schema: { body: fieldsBodySchema } },
    async (request, reply) => {
      const extraction = await prisma.registerEntryExtraction.findUnique({
        where: { id: request.params.id },
        select: {
          id: true,
          projectId: true,
          proposedAt: true,
          confirmedAt: true,
          rejectedAt: true,
          documentVersionId: true,
          ingestedDocumentFile: {
            select: {
              filename: true,
              contentType: true,
              byteSize: true,
              storageKey: true,
            },
          },
        },
      });
      if (extraction === null) {
        return noSuchExtraction(reply);
      }
      if (extraction.confirmedAt !== null || extraction.rejectedAt !== null) {
        return reply
          .code(409)
          .send({ message: 'that extraction is already resolved' });
      }
      if (extraction.proposedAt === null) {
        return reply
          .code(409)
          .send({ message: 'that extraction has not proposed' });
      }

      const arrivalPath = extraction.ingestedDocumentFile !== null;
      const refusal =
        titleRevisionRefusal(arrivalPath, request.body) ??
        questionRefusal(request.body);
      if (refusal !== null) {
        return refuse(reply, refusal);
      }

      const file = extraction.ingestedDocumentFile;
      if (
        file !== null &&
        !(DOCUMENT_CONTENT_TYPES as readonly string[]).includes(file.contentType)
      ) {
        // 0039's closed set, holding here because the version's read route
        // hands the stored type back to a browser. The arrival is kept, its
        // bytes still served, and the manual document path stands — the
        // record is not lost. Widening the set is its own change.
        return reply.code(409).send({
          message: "that file's type is not one a document version carries",
        });
      }

      const body = request.body;
      const register = await prisma.register.findFirstOrThrow({
        where: { projectId: extraction.projectId, kind: body.kind },
        select: { id: true },
      });

      const now = timeSource.now();
      try {
        await prisma.$transaction(async (tx) => {
          let documentVersionId: string;
          if (file !== null) {
            const document = await tx.document.create({
              data: {
                projectId: extraction.projectId,
                title: body.title!,
                referencedFile: false,
                createdAt: now,
              },
              select: { id: true },
            });
            const version = await tx.documentVersion.create({
              data: {
                documentId: document.id,
                revision: body.revision!,
                filename: file.filename,
                contentType: file.contentType,
                byteSize: file.byteSize,
                storageKey: file.storageKey,
                createdAt: now,
              },
              select: { id: true },
            });
            documentVersionId = version.id;
          } else {
            documentVersionId = extraction.documentVersionId!;
          }

          const entry = await tx.registerEntry.create({
            data: {
              registerId: register.id,
              number: body.number,
              subject: body.subject,
              fromParty: body.fromParty,
              toParty: body.toParty,
              question: body.question ?? null,
              response: body.response ?? null,
              turnaroundDays: body.turnaroundDays ?? null,
              createdAt: now,
              handoffs: { create: handoffData(body.ballInCourt, timeSource) },
            },
            select: { id: true },
          });
          await tx.registerEntryDocumentVersion.create({
            data: {
              registerEntryId: entry.id,
              documentVersionId,
            },
          });
          const settled = await tx.registerEntryExtraction.updateMany({
            where: { id: extraction.id, confirmedAt: null, rejectedAt: null },
            data: { confirmedAt: now, registerEntryId: entry.id },
          });
          if (settled.count === 0) {
            throw new AlreadyResolved();
          }
        });
      } catch (error) {
        if (error instanceof AlreadyResolved) {
          return reply
            .code(409)
            .send({ message: 'that extraction is already resolved' });
        }
        // Narrowed to the number: `(register_id, number)` is the constraint
        // a legitimate second confirm collides on, and the join rows carry
        // composite keys of their own.
        if (violates(error, 'number')) {
          return reply
            .code(409)
            .send({ message: 'that number is already in this register' });
        }
        throw error;
      }

      const updated = await prisma.registerEntryExtraction.findUniqueOrThrow({
        where: { id: extraction.id },
        select: extractionSelect,
      });
      return reply.code(201).send(extractionOnTheWire(updated));
    },
  );

  /**
   * Rejecting an extraction (story 88). The source stands — nothing here
   * touches the arrival or the document — and so does what the agent
   * proposed: that it was made and that the engineer declined it are both
   * part of the record.
   */
  v1.post<{ Params: { id: string } }>(
    '/extractions/:id/reject',
    async (request, reply) => {
      const extraction = await prisma.registerEntryExtraction.findUnique({
        where: { id: request.params.id },
        select: { id: true, proposedAt: true, confirmedAt: true, rejectedAt: true },
      });
      if (extraction === null) {
        return noSuchExtraction(reply);
      }
      if (extraction.confirmedAt !== null || extraction.rejectedAt !== null) {
        return reply
          .code(409)
          .send({ message: 'that extraction is already resolved' });
      }
      if (extraction.proposedAt === null) {
        return reply
          .code(409)
          .send({ message: 'that extraction has not proposed' });
      }

      const settled = await prisma.registerEntryExtraction.updateMany({
        where: { id: extraction.id, confirmedAt: null, rejectedAt: null },
        data: { rejectedAt: timeSource.now() },
      });
      if (settled.count === 0) {
        return reply
          .code(409)
          .send({ message: 'that extraction is already resolved' });
      }

      const updated = await prisma.registerEntryExtraction.findUniqueOrThrow({
        where: { id: extraction.id },
        select: extractionSelect,
      });
      return extractionOnTheWire(updated);
    },
  );

  /**
   * The extractions as they move, over the shared stream machinery
   * (ADR-0035's leaf, reached for a fourth time). The state, never a
   * percentage (story 90): what the engineer sees moving is queued, running,
   * and the proposal arriving.
   */
  v1.get<{ Params: { id: string } }>(
    '/projects/:id/extractions/stream',
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }
      const projectId = project.id;
      await stream(request, reply, async () => {
        const extractions = await prisma.registerEntryExtraction.findMany({
          where: { projectId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: extractionSelect,
        });
        return { extractions: extractions.map(extractionOnTheWire) };
      });
    },
  );
}

/** The proposal's scalar fields onto their columns, which differ only in prefix. */
function mapRest(rest: { number: string; subject: string; fromParty: string; toParty: string }) {
  return {
    proposedNumber: rest.number,
    proposedSubject: rest.subject,
    proposedFromParty: rest.fromParty,
    proposedToParty: rest.toParty,
  };
}
