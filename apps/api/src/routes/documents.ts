/** Documents, their immutable versions, and what points at them (issue #17). */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import {
  isUniqueViolation,
  NOT_BLANK,
  type RouteDependencies,
  violates,
} from '../http.js';
import {
  NO_SUCH_DOCUMENT_VERSION,
  noSuchDocument,
  noSuchDocumentVersion,
  noSuchProject,
  noSuchRegisterEntry,
  noSuchSubmission,
  refuse,
  type Refusal,
} from '../refusals.js';

/**
 * The document types the boundary admits, byte-exact and closed.
 *
 * Closed rather than anything at all, because the read route hands this value
 * straight back as the response's content type: a row carrying `text/html`
 * would be a page this product served under its own origin. A CHECK
 * constraint names the same three underneath, the way a photograph's four are
 * named in both places.
 *
 * Three, because a drawing set and a spec book arrive as PDF and a spec
 * section or a schedule arrives as Word or Excel. Anything else is not a
 * document this ticket names, and widening the set is a migration rather than
 * a string a caller invents.
 *
 * Exported for `routes/extractions.ts`, whose confirmation writes a document
 * version out of an arrival's file and must refuse what this set refuses —
 * the shape ADR-0030 gave `observationBodySchema`, where the second writer of
 * a table reads the first writer's boundary rather than restating it.
 */
export const DOCUMENT_CONTENT_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

/**
 * The longest base64 string the boundary takes, which is forty-eight
 * mebibytes of file. Named for the string because that is what `maxLength`
 * measures.
 *
 * The cap the plan does not state, and four times a photograph's for a reason:
 * the case this ticket names by hand is an 86-sheet 48"x36" set. A vector set
 * plotted out of Revit or AutoCAD is single-digit to low-tens of megabytes, so
 * forty-eight clears every one of those. A **scanned** large-format set can
 * exceed it, and that is the case that would move this boundary off base64 and
 * on to a streamed body — a known limit rather than a surprise.
 */
const DOCUMENT_BASE64_MAX = 67_108_864;

/** The body plus its JSON, so the limit refuses a file and not a request. */
const DOCUMENT_BODY_LIMIT = DOCUMENT_BASE64_MAX + 64 * 1024;

/**
 * One version on the way in.
 *
 * The bytes arrive base64 in the JSON body rather than as multipart, so the
 * revision, the filename and the type are refused by the same schema as every
 * other field in this product instead of by a hand-written check on the far
 * side of a plugin (ADR-0032's reasoning, and its cost: a third more on the
 * wire).
 */
const versionBodySchema = {
  type: 'object',
  required: ['revision', 'filename', 'contentType', 'bytes'],
  additionalProperties: false,
  properties: {
    // Capped at the submission revision's 32, being the same kind of short
    // designation an engineer writes by hand.
    revision: { type: 'string', pattern: NOT_BLANK, maxLength: 32 },
    // The photograph's 255: long enough for a real name, short enough to be a
    // filename rather than a sentence.
    filename: { type: 'string', pattern: NOT_BLANK, maxLength: 255 },
    contentType: { type: 'string', enum: [...DOCUMENT_CONTENT_TYPES] },
    // Strict base64: whole quartets, with the only short tail being the one
    // padding makes legal. `[A-Za-z0-9+/]+={0,2}` is the looser pattern the
    // photograph and the recording use, and it admits a length of 4n+1 —
    // which is not base64 at all, and which `Buffer.from` **silently
    // truncates** rather than refusing. That would store a short file and
    // answer 201, so the corruption would reach the record with nothing to
    // read it back against. `minLength` keeps the empty string out, which is
    // the nothing the CHECK constraint refuses.
    bytes: {
      type: 'string',
      pattern:
        '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$',
      minLength: 4,
      maxLength: DOCUMENT_BASE64_MAX,
    },
  },
} as const;

/**
 * A document on the way in, with its first version named in the same call.
 *
 * Named together for ADR-0026's reason and ADR-0036's: a document that existed
 * as a title with no bytes would be a record of nothing, the way a register
 * entry with no first handoff would have no holder.
 *
 * `referencedFile` is **required and has no default**. A default would
 * classify by omission, and the omitted answer is the dangerous one — between
 * recording and marking, an 86-sheet set would be an extraction target, which
 * is exactly the liability this ticket exists to refuse.
 */
const documentBodySchema = {
  type: 'object',
  required: ['title', 'referencedFile', 'version'],
  additionalProperties: false,
  properties: {
    // Capped at the project name's 200, being the other free-text name.
    title: { type: 'string', pattern: NOT_BLANK, maxLength: 200 },
    referencedFile: { type: 'boolean' },
    version: versionBodySchema,
  },
} as const;

interface VersionBody {
  revision: string;
  filename: string;
  contentType: string;
  bytes: string;
}

/**
 * What a document is read with: every version it has ever had, oldest first.
 *
 * A total order, because two versions recorded in the same millisecond would
 * otherwise list at random and "which one is current" would move between
 * reads.
 */
const documentInclude = {
  versions: { orderBy: [{ createdAt: 'asc' }, { revision: 'asc' }] },
} satisfies Prisma.DocumentInclude;

type StoredDocument = Prisma.DocumentGetPayload<{
  include: typeof documentInclude;
}>;

/** A version read through what points at it, carrying its document. */
const linkedVersionInclude = {
  document: true,
} satisfies Prisma.DocumentVersionInclude;

type LinkedVersion = Prisma.DocumentVersionGetPayload<{
  include: typeof linkedVersionInclude;
}>;

/**
 * A document on the wire, which is the row plus its versions **minus** every
 * storage key.
 *
 * The key is the object store's business and means something different the
 * day the adapter changes, the way a photograph's and a recording's do. A
 * test asserts the exact key set both shapes come back with.
 */
function documentOnTheWire(document: StoredDocument) {
  const versions = document.versions.map((version) => {
    const { storageKey: _key, ...onTheWire } = version;
    return onTheWire;
  });
  return { ...document, versions };
}

/** One version on the wire, with the document it is a version of. */
function linkedVersionOnTheWire(version: LinkedVersion) {
  const { storageKey: _key, document, ...onTheWire } = version;
  return { ...onTheWire, document };
}

/**
 * What a structure points at, oldest stored first.
 *
 * One query for both readers: an issuance and a register entry differ only in
 * which join they look through, and two copies of this would be two places for
 * the order or the wire shape to drift.
 */
async function linkedVersions(
  prisma: PrismaClient,
  where: Prisma.DocumentVersionWhereInput,
) {
  const linked = await prisma.documentVersion.findMany({
    where,
    orderBy: [{ createdAt: 'asc' }, { revision: 'asc' }],
    include: linkedVersionInclude,
  });
  return linked.map(linkedVersionOnTheWire);
}

/**
 * The bytes down first, under a key generated here, and the row that points at
 * them second.
 *
 * Never the other way round and never both inside one transaction (ADR-0032):
 * `put` against the S3 adapter is a network write, and holding a database
 * connection across it would blow Prisma's interactive-transaction timeout on
 * a forty-megabyte drawing set and roll back a row whose object was already
 * stored. The cost is an orphaned object when the insert is refused — garbage
 * in the store that no reader reaches. The alternative costs a row pointing at
 * bytes that are not there, which is the one a reader *does* reach.
 */
async function storeBytes(
  objectStore: RouteDependencies['objectStore'],
  version: VersionBody,
): Promise<{ storageKey: string; byteSize: number }> {
  const bytes = Buffer.from(version.bytes, 'base64');
  const storageKey = `documents/${randomUUID()}`;
  await objectStore.put(storageKey, bytes, version.contentType);
  return { storageKey, byteSize: bytes.byteLength };
}

/**
 * Why a version named in a link cannot be used here. Missing is a 404;
 * belonging to another job is a 409, because it exists and is simply not this
 * project's to point at — `openItemRefusal`'s shape exactly.
 */
async function versionRefusal(
  prisma: PrismaClient,
  documentVersionId: string,
  projectId: string,
): Promise<Refusal | null> {
  const version = await prisma.documentVersion.findUnique({
    where: { id: documentVersionId },
    select: { document: { select: { projectId: true } } },
  });
  if (version === null) {
    return { code: 404, message: NO_SUCH_DOCUMENT_VERSION };
  }
  if (version.document.projectId !== projectId) {
    return { code: 409, message: 'that document is on another project' };
  }
  return null;
}

export function documentRoutes(
  v1: FastifyInstance,
  { prisma, objectStore, timeSource }: RouteDependencies,
): void {
  /**
   * Storing a document against a job, with its first version (story 94).
   *
   * "Light metadata" is the title and whether it is a referenced file, and
   * that is the whole of it. ADR-0008 names four more extracted fields —
   * document number, date, discipline, document type — and they are
   * extraction's to produce; a column nothing writes and nothing reads is a
   * column nobody can trust.
   */
  v1.post<{
    Params: { id: string };
    Body: { title: string; referencedFile: boolean; version: VersionBody };
  }>(
    '/projects/:id/documents',
    { schema: { body: documentBodySchema }, bodyLimit: DOCUMENT_BODY_LIMIT },
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }

      const { title, referencedFile, version } = request.body;
      const stored = await storeBytes(objectStore, version);
      const recordedAt = timeSource.now();

      const document = await prisma.document.create({
        data: {
          projectId: project.id,
          title,
          referencedFile,
          createdAt: recordedAt,
          versions: {
            create: {
              revision: version.revision,
              filename: version.filename,
              contentType: version.contentType,
              byteSize: stored.byteSize,
              storageKey: stored.storageKey,
              createdAt: recordedAt,
            },
          },
        },
        include: documentInclude,
      });
      return reply.code(201).send(documentOnTheWire(document));
    },
  );

  /**
   * A newer revision of a document already stored (story 96).
   *
   * A new row, and nothing at all is written to the one it follows — which is
   * what makes "which version did we issue against" answerable years later.
   * ADR-0028's reissue and ADR-0029's rerun arriving for a fourth record.
   *
   * The whole document comes back rather than the version alone, so that the
   * one response says what the record now is: the prior revisions still
   * standing beside the new one.
   */
  v1.post<{ Params: { id: string }; Body: VersionBody }>(
    '/documents/:id/versions',
    { schema: { body: versionBodySchema }, bodyLimit: DOCUMENT_BODY_LIMIT },
    async (request, reply) => {
      const document = await prisma.document.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (document === null) {
        return noSuchDocument(reply);
      }

      const version = request.body;
      const stored = await storeBytes(objectStore, version);

      try {
        await prisma.documentVersion.create({
          data: {
            documentId: document.id,
            revision: version.revision,
            filename: version.filename,
            contentType: version.contentType,
            byteSize: stored.byteSize,
            storageKey: stored.storageKey,
            createdAt: timeSource.now(),
          },
        });
      } catch (error) {
        // Narrowed to the revision. The insert also writes a fresh storage
        // key, and answering "already a revision" to a collision there would
        // be a lie at the one moment anybody read it.
        if (violates(error, 'revision')) {
          return reply
            .code(409)
            .send({ message: 'that revision is already on this document' });
        }
        throw error;
      }

      const withNew = await prisma.document.findUniqueOrThrow({
        where: { id: document.id },
        include: documentInclude,
      });
      return reply.code(201).send(documentOnTheWire(withNew));
    },
  );

  /**
   * The bytes themselves, served through the API.
   *
   * Not a presigned URL, for ADR-0032's reason: [[0020]] puts one shared
   * secret in front of every route and carved out exactly one exception,
   * reasoning about it explicitly, and that ADR is still Proposed.
   */
  v1.get<{ Params: { id: string } }>(
    '/document-versions/:id/bytes',
    async (request, reply) => {
      const found = await prisma.documentVersion.findUnique({
        where: { id: request.params.id },
        select: { storageKey: true, contentType: true },
      });
      if (found === null) {
        return noSuchDocumentVersion(reply);
      }

      const bytes = await objectStore.get(found.storageKey);
      return reply
        .header('content-type', found.contentType)
        // One of three document types, and the browser is told not to look
        // for a fourth.
        .header('x-content-type-options', 'nosniff')
        .send(bytes);
    },
  );

  /**
   * What is stored against this job (story 97).
   *
   * Retrieval by identity: the document is found through the structure it
   * already belongs to, so finding it never depends on remembering what it
   * was called (ADR-0019). There is no query parameter here and no index to
   * search — the same reason there is none anywhere else in this product.
   */
  v1.get<{ Params: { id: string } }>(
    '/projects/:id/documents',
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }

      const documents = await prisma.document.findMany({
        where: { projectId: project.id },
        orderBy: [{ createdAt: 'asc' }, { title: 'asc' }],
        include: documentInclude,
      });
      return documents.map(documentOnTheWire);
    },
  );

  /**
   * Marking a document as a referenced file after the fact.
   *
   * The criterion's own verb — "**mark** a document as a referenced file,
   * which excludes it from any future extraction queue" — so it is an action
   * on a document and not only an answer given while recording one. A
   * misclassification made at entry is otherwise permanent, and the screen
   * asks the question as a choice, so a wrong click is the failure mode
   * rather than an omission.
   *
   * **One way, and that is the whole of its safety.** It sets the column true
   * and there is no route that sets it false: a correction may always take a
   * document out of extraction's reach and may never put one into it, so the
   * 86-sheet set this ticket exists to keep away from a document pipeline
   * cannot be walked back into one. Marking an already-referenced file is
   * refused rather than repeated, the shape a response, a turnaround and a
   * disposition each have.
   *
   * This is the one column on a document anything writes after it is
   * recorded, and it is a correction in one action — the shape ADR-0032 gave
   * a photograph's two bindings, and stricter, since a photograph's are
   * reversible and this is not.
   */
  v1.post<{ Params: { id: string } }>(
    '/documents/:id/referenced-file',
    async (request, reply) => {
      const document = await prisma.document.findUnique({
        where: { id: request.params.id },
        select: { id: true, referencedFile: true },
      });
      if (document === null) {
        return noSuchDocument(reply);
      }
      if (document.referencedFile) {
        return reply
          .code(409)
          .send({ message: 'that document is already a referenced file' });
      }

      const marked = await prisma.document.update({
        where: { id: document.id },
        data: { referencedFile: true },
        include: documentInclude,
      });
      return documentOnTheWire(marked);
    },
  );

  /**
   * The documents on this job that extraction would ever be pointed at —
   * which is every one that is **not** a referenced file.
   *
   * A read over what is already stored. It queues nothing itself and reads
   * no document's contents; the extraction pass is issue #20's and this list
   * is the one predicate its enqueuer reads — `POST /documents/:id/extractions`
   * refuses a referenced file for the same reason this list excludes it, so
   * "a referenced file is never enqueued" holds at the write as well as at
   * the read (ADR-0043).
   *
   * Scoped to a project and deliberately **not** offered across every job.
   * Exposure and the clock are the two daily lists (ADR-0016, ADR-0038); a
   * third across-every-project count is the figure this product keeps
   * refusing to grow.
   */
  v1.get<{ Params: { id: string } }>(
    '/projects/:id/extraction-targets',
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }

      const targets = await prisma.document.findMany({
        where: { projectId: project.id, referencedFile: false },
        orderBy: [{ createdAt: 'asc' }, { title: 'asc' }],
        include: documentInclude,
      });
      return targets.map(documentOnTheWire);
    },
  );

  /**
   * The defined set points at the actual document (story 95).
   *
   * A join row and nothing written to the submission, which is what keeps "no
   * route updates a submission" true by construction (ADR-0026, ADR-0028) —
   * the same reason the link to the issuance that answered a register entry
   * is a column on the entry (ADR-0036).
   *
   * It points at a **version**, so "which version did we issue against" has an
   * answer. It does not point at a *sheet*: ADR-0026 and the glossary both
   * price that as a migration off the sheet list's text column, and nothing
   * here addresses a single sheet.
   *
   * Not narrowed to a referenced file, though the story names one. ADR-0037
   * declined to narrow a next round to a Revise and Resubmit for the same
   * reason: the transmittal that went out with a set is a document too, and a
   * refusal here would be a rule nobody asked for.
   */
  v1.post<{ Params: { id: string; documentVersionId: string } }>(
    '/submissions/:id/documents/:documentVersionId',
    async (request, reply) => {
      const { id, documentVersionId } = request.params;
      const submission = await prisma.submission.findUnique({
        where: { id },
        select: { id: true, projectId: true },
      });
      if (submission === null) {
        return noSuchSubmission(reply);
      }

      const bad = await versionRefusal(
        prisma,
        documentVersionId,
        submission.projectId,
      );
      if (bad !== null) {
        return refuse(reply, bad);
      }

      try {
        await prisma.submissionDocumentVersion.create({
          data: { submissionId: submission.id, documentVersionId },
        });
      } catch (error) {
        // Unqualified, and safe to be: the composite key is the only
        // constraint this insert can hit.
        if (isUniqueViolation(error)) {
          return reply
            .code(409)
            .send({ message: 'that document is already on this submission' });
        }
        throw error;
      }
      return reply.code(204).send();
    },
  );

  /** What this issuance's sheet list points at, oldest stored first. */
  v1.get<{ Params: { id: string } }>(
    '/submissions/:id/documents',
    async (request, reply) => {
      const submission = await prisma.submission.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (submission === null) {
        return noSuchSubmission(reply);
      }

      return linkedVersions(prisma, { submissions: { some: { submissionId: submission.id } } });
    },
  );

  /**
   * What a piece of correspondence arrived with, or was answered by (story
   * 97) — a submittal package, an RFI's marked-up sketch.
   *
   * The `register_entry_open_items` shape, and the third record to answer a
   * "link something to this entry" question the same way.
   */
  v1.post<{ Params: { id: string; documentVersionId: string } }>(
    '/register-entries/:id/documents/:documentVersionId',
    async (request, reply) => {
      const { id, documentVersionId } = request.params;
      const entry = await prisma.registerEntry.findUnique({
        where: { id },
        select: { id: true, register: { select: { projectId: true } } },
      });
      if (entry === null) {
        return noSuchRegisterEntry(reply);
      }

      const bad = await versionRefusal(
        prisma,
        documentVersionId,
        entry.register.projectId,
      );
      if (bad !== null) {
        return refuse(reply, bad);
      }

      try {
        await prisma.registerEntryDocumentVersion.create({
          data: { registerEntryId: entry.id, documentVersionId },
        });
      } catch (error) {
        // Unqualified, and safe to be: the composite key is the only
        // constraint this insert can hit.
        if (isUniqueViolation(error)) {
          return reply
            .code(409)
            .send({ message: 'that document is already on this entry' });
        }
        throw error;
      }
      return reply.code(204).send();
    },
  );

  /** What this entry points at, oldest stored first. */
  v1.get<{ Params: { id: string } }>(
    '/register-entries/:id/documents',
    async (request, reply) => {
      const entry = await prisma.registerEntry.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (entry === null) {
        return noSuchRegisterEntry(reply);
      }

      return linkedVersions(prisma, { registerEntries: { some: { registerEntryId: entry.id } } });
    },
  );
}

