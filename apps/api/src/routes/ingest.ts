/** The ingest address and what arrives at it (issue #19). */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '../../generated/prisma/client.js';
import { NOT_BLANK, type RouteDependencies } from '../http.js';
import type { InboundFile, InboundMessage } from '../inbound-mail.js';
import { noSuchIngestedDocumentFile, noSuchProject } from '../refusals.js';

/**
 * Whole quartets, as a document version's bytes are and unlike a photograph's
 * or a recording's (ADR-0039). The looser pattern admits a length of 4n+1,
 * which `Buffer.from` silently truncates rather than refusing — so a short
 * file would store and the route would answer 201.
 */
const BASE64 =
  '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$';

const base64 = new RegExp(BASE64);

/**
 * Twenty-four mebibytes of file across a whole message, named for the string
 * because that is what a length check measures.
 *
 * Under a document version's forty-eight: this is mail, and every provider
 * caps a message well below that. A set too large to send is the case the
 * manual path exists for.
 */
const INGEST_BASE64_MAX = 33_554_432;

/** The body plus its JSON, so the limit refuses a message and not a request. */
const INGEST_BODY_LIMIT = INGEST_BASE64_MAX + 64 * 1024;

/**
 * How many messages one address accepts in the trailing hour (story 83).
 *
 * A count of the rows already here, dated by `arrived_at` and read through the
 * `TimeSource` — an arithmetic over the record rather than a counter beside
 * it, the shape ADR-0027 gave exposure and ADR-0037 gave the clock. A counter
 * in Redis would be a second place the number lives, with its own expiry, its
 * own test seam and its own answer to being empty (ADR-0042).
 */
const INGEST_LIMIT_PER_WINDOW = 60;

const INGEST_WINDOW_MS = 60 * 60 * 1000;

const fileBodySchema = {
  type: 'object',
  required: ['filename', 'contentType', 'bytes'],
  additionalProperties: false,
  properties: {
    filename: { type: 'string', pattern: NOT_BLANK, maxLength: 255 },
    // Free text and deliberately not ADR-0039's closed set of three: refusing
    // a `.dwg` would lose the record the fallback exists to protect. The hole
    // that opens is closed at the read, where the bytes route never echoes
    // this value into a header (ADR-0042).
    contentType: { type: 'string', pattern: NOT_BLANK, maxLength: 255 },
    bytes: {
      type: 'string',
      pattern: BASE64,
      minLength: 4,
      maxLength: INGEST_BASE64_MAX,
    },
  },
} as const;

const manualBodySchema = {
  type: 'object',
  required: ['files'],
  additionalProperties: false,
  properties: {
    note: { type: 'string', pattern: NOT_BLANK, maxLength: 2000 },
    files: { type: 'array', maxItems: 100, items: fileBodySchema },
  },
} as const;

interface FileBody {
  filename: string;
  contentType: string;
  bytes: string;
}

const ingestedDocumentInclude = {
  files: { orderBy: [{ createdAt: 'asc' }, { filename: 'asc' }] },
} satisfies Prisma.IngestedDocumentInclude;

type StoredArrival = Prisma.IngestedDocumentGetPayload<{
  include: typeof ingestedDocumentInclude;
}>;

/** The key never reaches the wire, as a photograph's and a version's do not. */
function arrivalOnTheWire(arrival: StoredArrival) {
  const files = arrival.files.map((file) => {
    const { storageKey: _key, ...onTheWire } = file;
    return onTheWire;
  });
  return { ...arrival, files };
}

/**
 * The token out of the address a message was sent to.
 *
 * Handles `Name <token@domain>` as well as a bare address, because a provider
 * hands on the `To` header as it found it. The domain is deliberately not
 * checked: the token is the credential and mail addressed elsewhere never
 * reaches this endpoint anyway.
 */
function tokenIn(recipient: string): string | null {
  const angled = /<([^>]*)>/.exec(recipient);
  const address = (angled?.[1] ?? recipient).trim();
  const at = address.lastIndexOf('@');
  if (at <= 0) {
    return null;
  }
  return address.slice(0, at);
}

/**
 * The same check the manual path's body schema makes, for a message that did
 * not come through one. What the provider normalised is still a sender's
 * claim, so it is validated here rather than trusted.
 */
function checkedFiles(files: InboundFile[]): FileBody[] {
  if (files.length > 100) {
    throw new Error('too many files on one message');
  }
  let total = 0;
  return files.map((file) => {
    if (file.filename.trim() === '' || file.filename.length > 255) {
      throw new Error('a file has no usable name');
    }
    if (file.contentType.trim() === '' || file.contentType.length > 255) {
      throw new Error('a file has no usable content type');
    }
    total += file.bytes.length;
    if (
      file.bytes.length < 4 ||
      total > INGEST_BASE64_MAX ||
      !base64.test(file.bytes)
    ) {
      throw new Error('a file did not arrive as whole base64');
    }
    return file;
  });
}

/**
 * The bytes go to the store **before** the rows that point at them, and never
 * inside a transaction with them (ADR-0032). An orphaned object is garbage no
 * reader reaches; a row pointing at bytes that are not there is not.
 */
async function storeFiles(
  objectStore: RouteDependencies['objectStore'],
  files: FileBody[],
  now: Date,
) {
  const stored = [];
  for (const file of files) {
    const bytes = Buffer.from(file.bytes, 'base64');
    const storageKey = `ingest/${randomUUID()}`;
    await objectStore.put(storageKey, bytes, file.contentType);
    stored.push({
      filename: file.filename,
      contentType: file.contentType,
      byteSize: bytes.byteLength,
      storageKey,
      createdAt: now,
    });
  }
  return stored;
}

export function ingestRoutes(
  v1: FastifyInstance,
  { prisma, objectStore, timeSource, inboundMail }: RouteDependencies,
): void {
  /**
   * Where the inbound mail provider posts (stories 82, 83, 84 and 89).
   *
   * The body carries no schema on purpose: it is the provider's shape and not
   * this product's, and normalising it is the whole of what the port is for.
   * What comes back out of `read` is checked here like any other input.
   *
   * This route is the one thing in the product reachable without whatever
   * ADR-0020 eventually puts in front of the API — that ADR carves the ingest
   * addresses out by name, because inbound mail cannot present a cookie, and
   * says their unguessability and rate limiting stand in its place. Both are
   * below.
   */
  v1.post(
    '/ingest/inbound-mail',
    { bodyLimit: INGEST_BODY_LIMIT },
    async (request, reply) => {
      if (!inboundMail.configured) {
        // A deployment fact, not a payload fact. Reporting it as a 400 would
        // tell a provider to stop retrying something that will work as soon
        // as an adapter is written (ADR-0042).
        return reply
          .code(503)
          .send({ message: 'no inbound mail provider is configured' });
      }

      let message: InboundMessage;
      let files: FileBody[];
      try {
        message = inboundMail.read(request.body);
        files = checkedFiles(message.files);
      } catch {
        // Deliberately not the thrown text: it is derived from a payload a
        // stranger sent, and this is the one endpoint a stranger reaches.
        return reply
          .code(400)
          .send({ message: 'that message could not be read' });
      }

      const token = tokenIn(message.recipient);
      const project =
        token === null
          ? null
          : await prisma.project.findUnique({
              where: { ingestToken: token },
              select: { id: true },
            });

      if (project === null) {
        // The same answer for a malformed address and for one that names no
        // job: an address is a credential, and saying which of the two it was
        // would tell a stranger when they had guessed the shape.
        return reply
          .code(404)
          .send({ message: 'no ingest address matches that recipient' });
      }

      const now = timeSource.now();
      const since = new Date(now.getTime() - INGEST_WINDOW_MS);
      const recent = await prisma.ingestedDocument.count({
        where: { projectId: project.id, source: 'EMAIL', arrivedAt: { gte: since } },
      });
      if (recent >= INGEST_LIMIT_PER_WINDOW) {
        return reply
          .code(429)
          .send({ message: 'that ingest address has taken too much lately' });
      }

      const stored = await storeFiles(objectStore, files, now);
      const arrival = await prisma.ingestedDocument.create({
        data: {
          projectId: project.id,
          source: 'EMAIL',
          arrivedAt: now,
          sender: message.sender,
          recipient: message.recipient,
          subject: message.subject ?? null,
          body: message.body ?? null,
          files: { create: stored },
        },
        include: ingestedDocumentInclude,
      });

      return reply.code(201).send(arrivalOnTheWire(arrival));
    },
  );

  /**
   * Entering one by hand (story 93).
   *
   * The same record, so a provider outage or an unusual source never blocks
   * it — which is why nothing here is rate limited: a limit on this path would
   * be a limit on the engineer's own hands.
   */
  v1.post<{ Params: { id: string }; Body: { note?: string; files: FileBody[] } }>(
    '/projects/:id/ingested-documents',
    { schema: { body: manualBodySchema }, bodyLimit: INGEST_BODY_LIMIT },
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }

      const now = timeSource.now();
      const stored = await storeFiles(objectStore, request.body.files, now);
      const arrival = await prisma.ingestedDocument.create({
        data: {
          projectId: project.id,
          source: 'MANUAL',
          arrivedAt: now,
          note: request.body.note ?? null,
          files: { create: stored },
        },
        include: ingestedDocumentInclude,
      });

      return reply.code(201).send(arrivalOnTheWire(arrival));
    },
  );

  /**
   * What has arrived on a job, reached through the job itself — retrieval is
   * by identity and there is no search box here or anywhere else (ADR-0019).
   *
   * Oldest first, as a job's documents are: an arrival is read in the order it
   * came in.
   */
  v1.get<{ Params: { id: string } }>(
    '/projects/:id/ingested-documents',
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }

      const arrivals = await prisma.ingestedDocument.findMany({
        where: { projectId: project.id },
        orderBy: [{ arrivedAt: 'asc' }, { id: 'asc' }],
        include: ingestedDocumentInclude,
      });
      return arrivals.map(arrivalOnTheWire);
    },
  );

  /**
   * The bytes of one file, served through the API and not a presigned URL —
   * that would be a second thing reachable without ADR-0020's gate, and 0020
   * is still Proposed (ADR-0032, ADR-0039).
   *
   * Always `application/octet-stream`, and never the type the sender claimed.
   * ADR-0039 could hand a document version's own type back because that set is
   * closed to three; nothing arriving from outside gets that, since a stored
   * `text/html` would otherwise be a page this product served under its own
   * origin. `nosniff` and a disposition say the same thing twice.
   */
  v1.get<{ Params: { id: string } }>(
    '/ingested-document-files/:id/bytes',
    async (request, reply) => {
      const file = await prisma.ingestedDocumentFile.findUnique({
        where: { id: request.params.id },
      });
      if (file === null) {
        return noSuchIngestedDocumentFile(reply);
      }

      const bytes = await objectStore.get(file.storageKey);
      return reply
        .header('content-type', 'application/octet-stream')
        .header('x-content-type-options', 'nosniff')
        // `attachment` is the token from RFC 6266 and is not this product's
        // word for anything (ADR-0042). The filename is a stranger's text, so
        // only the quoted form goes out and quotes are dropped from it.
        .header(
          'content-disposition',
          `attachment; filename="${file.filename.replace(/["\\\r\n]/g, '')}"`,
        )
        .send(bytes);
    },
  );
}
