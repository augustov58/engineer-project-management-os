/** The ingest address and what arrives at it (issue #19). */

import { randomUUID } from 'node:crypto';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import type {
  Prisma,
  PrismaClient,
} from '../../generated/prisma/client.js';
import { NOT_BLANK, type RouteDependencies } from '../http.js';
import type { InboundFile, InboundMessage } from '../inbound-mail.js';
import { noSuchProject, refuse, type Refusal } from '../refusals.js';

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
 * `content-disposition` for a filename an untrusted sender chose.
 *
 * Two forms, per RFC 6266. Node refuses a header value outside latin-1, so
 * interpolating the name raw makes an em dash, a curly quote or any CJK
 * character an `ERR_INVALID_CHAR` and a 500 — which would make a file
 * undownloadable because of what it was called. The ASCII form is stripped to
 * what a header can carry and the `filename*` form carries the real name
 * percent-encoded, which every current browser prefers.
 */
function disposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  const fallback = ascii.trim() === '' ? 'download' : ascii;
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
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
  return files.map((file) => {
    if (file.filename.trim() === '' || file.filename.length > 255) {
      throw new Error('a file has no usable name');
    }
    if (file.contentType.trim() === '' || file.contentType.length > 255) {
      throw new Error('a file has no usable content type');
    }
    // Per file, exactly as `fileBodySchema` caps it. The total across a
    // message is `INGEST_BODY_LIMIT`, which bounds both writers identically
    // because it bounds the request; an aggregate check here as well would be
    // the two paths into one table enforcing different limits.
    if (
      file.bytes.length < 4 ||
      file.bytes.length > INGEST_BASE64_MAX ||
      !base64.test(file.bytes)
    ) {
      throw new Error('a file did not arrive as whole base64');
    }
    return file;
  });
}

/** Both this record's own refusals, which nothing else sends (ADR-0033). */
const TOO_MUCH_LATELY: Refusal = {
  code: 429,
  message: 'that ingest address has taken too much lately',
};

const NO_SUCH_FILE: Refusal = {
  code: 404,
  message: 'no ingested document file with that id',
};

const UNREADABLE: Refusal = {
  code: 400,
  message: 'that message could not be read',
};

const NO_SUCH_ADDRESS: Refusal = {
  code: 404,
  message: 'no ingest address matches that recipient',
};

/**
 * Fastify's default 500 body is `{ message: err.message }`, and there is no
 * `setErrorHandler` in this product — so a Prisma or object-store failure
 * would put its own text in front of whoever posted. Everywhere else that is
 * a developer reading their own logs; here it is a stranger, because this is
 * the one route reachable without whatever ADR-0020 puts in front of the API.
 *
 * Scoped to this route deliberately. A `setErrorHandler` on the whole `/v1`
 * context would change what every other route answers, which is its own
 * change and not this ticket's (ADR-0033 keeps `server.ts` the boundary).
 */
const UNAVAILABLE: Refusal = {
  code: 500,
  message: 'that message could not be accepted',
};

/**
 * Whether this address has taken its hour's worth already.
 *
 * Takes the client rather than closing over one, so the transaction below can
 * ask the same question inside its lock that the cheap read asked outside it.
 */
async function overTheLimit(
  client: Pick<PrismaClient, 'ingestedDocument'>,
  projectId: string,
  now: Date,
): Promise<boolean> {
  const since = new Date(now.getTime() - INGEST_WINDOW_MS);
  const recent = await client.ingestedDocument.count({
    where: { projectId, source: 'EMAIL', arrivedAt: { gte: since } },
  });
  return recent >= INGEST_LIMIT_PER_WINDOW;
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
      try {
        return await acceptForwarded(request, reply);
      } catch (error) {
        request.log.error(error, 'an inbound message could not be accepted');
        return refuse(reply, UNAVAILABLE);
      }
    },
  );

  async function acceptForwarded(request: FastifyRequest, reply: FastifyReply) {
      if (!inboundMail.configured) {
        // A deployment fact, not a payload fact. Reporting it as a 400 would
        // tell a provider to stop retrying something that will work as soon
        // as an adapter is written (ADR-0042).
        return reply
          .code(503)
          .send({ message: 'no inbound mail provider is configured' });
      }

      let message: InboundMessage;
      try {
        message = inboundMail.read(request.body, request.headers);
      } catch {
        return refuse(reply, UNREADABLE);
      }

      // The address is resolved **before** the files are checked, so that a
      // stranger posting to an address that names nothing is turned away
      // before this walks a regular expression over megabytes of base64 they
      // chose. Only the envelope has been read to get here.
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
        return refuse(reply, NO_SUCH_ADDRESS);
      }

      let files: FileBody[];
      try {
        files = checkedFiles(message.files);
      } catch {
        // Deliberately not the thrown text: it is derived from a payload a
        // stranger sent, and this is the one endpoint a stranger reaches.
        return refuse(reply, UNREADABLE);
      }

      const now = timeSource.now();

      // Twice, and both are load-bearing. This read is cheap and refuses a
      // flood *before* its bytes are written, so a stranger who has the
      // address cannot fill the object store with garbage nobody reads.
      if (await overTheLimit(prisma, project.id, now)) {
        return refuse(reply, TOO_MUCH_LATELY);
      }

      const stored = await storeFiles(objectStore, files, now);

      const arrival = await prisma.$transaction(async (tx) => {
        // The second read is what makes the limit a bound rather than a
        // guess. Counting and then inserting is two statements, so without
        // this every message arriving in the same instant reads the same
        // count and every one of them passes — and this is the single route
        // in the product reachable without whatever ADR-0020 puts in front of
        // the API, where that ADR names the rate limit as what stands in its
        // place. A lock per project, so one job's mail cannot delay another's.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${project.id}))`;
        if (await overTheLimit(tx, project.id, now)) {
          return null;
        }
        return tx.ingestedDocument.create({
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
      });

      // The bytes are already stored and are now unreferenced. That is
      // ADR-0032's accepted trade in the direction it accepts it: an orphaned
      // object is garbage no reader reaches, where a row pointing at bytes
      // that are not there is not.
      if (arrival === null) {
        return refuse(reply, TOO_MUCH_LATELY);
      }

      return reply.code(201).send(arrivalOnTheWire(arrival));
  }

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
        return refuse(reply, NO_SUCH_FILE);
      }

      const bytes = await objectStore.get(file.storageKey);
      return reply
        .header('content-type', 'application/octet-stream')
        .header('x-content-type-options', 'nosniff')
        // `attachment` is the token from RFC 6266 and is not this product's
        // word for anything (ADR-0042).
        .header('content-disposition', disposition(file.filename))
        .send(bytes);
    },
  );
}
