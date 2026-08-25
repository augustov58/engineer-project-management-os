import type { Queue } from 'bullmq';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { systemTimeSource, type TimeSource } from './time-source.js';

export interface ServerDependencies {
  prisma: PrismaClient;
  queue: Queue;
  /** Defaults to the real clock; tests pass a fake and advance it by hand. */
  timeSource?: TimeSource;
  logger?: boolean;
}

/**
 * The plan's API shape is a versioned prefix (issue #1). One `register` call
 * carries it, so the version lives in a single place rather than in every path.
 */
const API_PREFIX = '/v1';

/**
 * No format for the project number is written down anywhere — only that it is
 * short, unique and immutable. `^\S+$` is that read literally: an identifier
 * you can say out loud and paste into an email subject, so no whitespace and
 * nothing long enough to stop being short.
 */
const projectBodySchema = {
  type: 'object',
  required: ['projectNumber', 'name'],
  additionalProperties: false,
  properties: {
    projectNumber: { type: 'string', pattern: '^\\S+$', maxLength: 32 },
    name: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const;

/**
 * Which half of the register to list. Archiving is the only thing that moves a
 * project between them, so one flag covers both screens.
 */
const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { archived: { type: 'boolean', default: false } },
} as const;

const UNIQUE_VIOLATION = 'P2002';

/** The one 404 body, so the two lookup routes cannot drift apart. */
function noSuchProject(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no project with that id' });
}

function isUniqueViolation(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === UNIQUE_VIOLATION
  );
}

/**
 * A unique violation, and specifically the one on the named column.
 * `writeIssuance` also writes join rows with a composite key of their own, so
 * an unqualified check would answer "that submission has already been
 * superseded" to a collision that had nothing to do with superseding — a
 * message that would be a lie at the one moment anybody read it.
 *
 * Matched against the whole of `meta` rather than a path into it. The pg
 * driver adapter reports the column under
 * `meta.driverAdapterError.cause.constraint.fields` and leaves `meta.target`
 * — the documented place — undefined, so reading the documented path would
 * quietly answer "not this constraint" to every violation and turn the race
 * this guards into a 500. Verified against a real P2002 from this schema.
 */
function violates(error: unknown, column: string): boolean {
  if (!isUniqueViolation(error)) {
    return false;
  }
  return JSON.stringify(error.meta ?? {}).includes(column);
}

/**
 * At least one character that is not whitespace. `minLength: 1` would accept
 * "   ", which stores as a filled-in field and reads as an empty one — and for
 * `waitingOn` would be indistinguishable on screen from nobody.
 */
const NOT_BLANK = '\\S';

/**
 * Caps are chosen the way the project name's 200 was: the plan states none,
 * and an unbounded column is a way to wedge the record. The counterfactual
 * and the resolution note get more room, being prose about consequences
 * rather than a name or a phrase.
 */
const openItemBodySchema = {
  type: 'object',
  required: ['unresolved', 'blocks', 'waitingOn', 'counterfactual'],
  additionalProperties: false,
  properties: {
    unresolved: { type: 'string', pattern: NOT_BLANK, maxLength: 500 },
    blocks: { type: 'string', pattern: NOT_BLANK, maxLength: 500 },
    // Null is nobody. A blank string is not — an empty field must never be a
    // way of saying that no one owes the next move (ADR-0014).
    waitingOn: { type: ['string', 'null'], pattern: NOT_BLANK, maxLength: 120 },
    // Optional so entry stays quick, and settable so a project's existing
    // items can be entered with the date they have actually been open since.
    waitingSince: { type: 'string', format: 'date-time' },
    invalidationTrigger: { type: 'string', pattern: NOT_BLANK, maxLength: 500 },
    counterfactual: { type: 'string', pattern: NOT_BLANK, maxLength: 1000 },
    owner: { type: 'string', pattern: NOT_BLANK, maxLength: 120 },
  },
} as const;

/** Resolving takes a note and a date; only the date may be left to the clock. */
const resolveBodySchema = {
  type: 'object',
  required: ['note'],
  additionalProperties: false,
  properties: {
    note: { type: 'string', pattern: NOT_BLANK, maxLength: 1000 },
    resolvedAt: { type: 'string', format: 'date-time' },
  },
} as const;

/** Which half of one project's open items to list. */
const openItemListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { resolved: { type: 'boolean', default: false } },
} as const;

/**
 * The pending items view. Unresolved is not a parameter: an item that is
 * resolved is not pending, which is the whole definition of the view.
 */
const pendingQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    waitingOn: { type: 'string', pattern: NOT_BLANK, maxLength: 120 },
    sort: { type: 'string', enum: ['oldest', 'newest'], default: 'oldest' },
  },
} as const;

/**
 * The reserved filter value for "no one owes the next move". Matched without
 * regard to case, because the screens render it as "Nobody" and typing back
 * what the screen shows must not silently become a search for a party of that
 * name. A blank `waitingOn=` is rejected instead, so a blank filter and this
 * one never collapse into each other.
 */
const NOBODY = 'nobody';

function meansNobody(waitingOn: string): boolean {
  return waitingOn.toLowerCase() === NOBODY;
}

/** The one 404 body for open items, matching the projects one. */
function noSuchOpenItem(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no open item with that id' });
}

/**
 * A supplied instant, or the injected time source. Parsing a string the
 * engineer typed is not reading the wall clock, so ADR-0022 is satisfied by
 * the fallback being `timeSource.now()` and never `new Date()`.
 */
function instant(supplied: string | undefined, timeSource: TimeSource): Date {
  return supplied === undefined ? timeSource.now() : new Date(supplied);
}

/**
 * A phase is per-project free text — "50% CD", "90% CD", "Building Permit
 * Set" (ADR-0015). The cap matches a party name: these are labels an engineer
 * says out loud, not prose.
 */
const phaseBodySchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: { name: { type: 'string', pattern: NOT_BLANK, maxLength: 120 } },
} as const;

/**
 * Reordering submits the whole ordered list rather than one move. It is then
 * atomic and idempotent, and there is no off-by-one to get wrong in a
 * `{ phase, toIndex }` call (ADR-0026).
 */
const phaseOrderBodySchema = {
  type: 'object',
  required: ['phaseIds'],
  additionalProperties: false,
  properties: { phaseIds: { type: 'array', items: { type: 'string' } } },
} as const;

const currentPhaseBodySchema = {
  type: 'object',
  required: ['phaseId'],
  additionalProperties: false,
  properties: { phaseId: { type: 'string' } },
} as const;

/**
 * What went out, to whom, when, and at what phase, as one record (issue #5).
 *
 * `issuedProvisional` is deliberately absent: it is stamped here from the open
 * items named right then, and a caller that could assert it would be able to
 * claim a set went out clean when it did not. `additionalProperties: false`
 * is what refuses the attempt.
 *
 * The phase may be left off, in which case the project's current phase is
 * used. Caps follow the open item's: 120 for a party, 32 for a revision an
 * engineer writes by hand, and 2000 for the sheet list, which is the one
 * field here that holds a list rather than a phrase.
 */
const submissionBodySchema = {
  type: 'object',
  required: ['recipient', 'recipientRole', 'revision', 'sheetList'],
  additionalProperties: false,
  properties: {
    phaseId: { type: 'string' },
    issuedAt: { type: 'string', format: 'date-time' },
    recipient: { type: 'string', pattern: NOT_BLANK, maxLength: 120 },
    recipientRole: { type: 'string', pattern: NOT_BLANK, maxLength: 120 },
    revision: { type: 'string', pattern: NOT_BLANK, maxLength: 32 },
    sheetList: { type: 'string', pattern: NOT_BLANK, maxLength: 2000 },
    // What the set rests on, named while recording it. Issue #6 stamps
    // whether the submission went out on unconfirmed inputs at the moment of
    // issuance and never recomputes it, so there has to be a moment at which
    // both the row and what it rests on exist together. Attaching afterwards
    // stays available; it is the correction, not the entry path.
    openItemIds: { type: 'array', items: { type: 'string' }, maxItems: 100 },
  },
} as const;

/** The one 404 body for phases, matching the projects one. */
function noSuchPhase(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no phase with that id' });
}

/**
 * Why a record named in a request cannot be used here. Missing is a 404;
 * belonging to another job is a 409, because it exists and is simply not
 * this project's to issue at or to rest on.
 */
interface Refusal {
  code: number;
  message: string;
}

function refuse(reply: FastifyReply, refusal: Refusal) {
  return reply.code(refusal.code).send({ message: refusal.message });
}

async function phaseRefusal(
  prisma: PrismaClient,
  phaseId: string,
  projectId: string,
): Promise<Refusal | null> {
  const phase = await prisma.projectPhase.findUnique({
    where: { id: phaseId },
    select: { projectId: true },
  });
  if (phase === null) {
    return { code: 404, message: 'no phase with that id' };
  }
  if (phase.projectId !== projectId) {
    return { code: 409, message: 'that phase belongs to another project' };
  }
  return null;
}

async function openItemRefusal(
  prisma: PrismaClient,
  openItemId: string,
  projectId: string,
): Promise<Refusal | null> {
  const item = await prisma.openItem.findUnique({
    where: { id: openItemId },
    select: { subjectType: true, subjectId: true },
  });
  if (item === null) {
    return { code: 404, message: 'no open item with that id' };
  }
  if (item.subjectType !== 'PROJECT' || item.subjectId !== projectId) {
    return { code: 409, message: 'that open item is on another project' };
  }
  return null;
}

/** The one 404 body for submissions, matching the projects one. */
function noSuchSubmission(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no submission with that id' });
}

/**
 * The one already-superseded body. Said twice by the reissue route — once by
 * the check that reads the successor, once by the index catching a race — and
 * a reworded message must not become two different sentences.
 */
function alreadySuperseded(reply: FastifyReply) {
  return reply
    .code(409)
    .send({ message: 'that submission has already been superseded' });
}

/** Which project's exposure, or every live one's. */
const exposureQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { projectId: { type: 'string' } },
} as const;

/**
 * The relations the facts stored nowhere are read from: what a submission
 * rests on, and whether anything has replaced it. Selected rather than
 * included, so a list read does not drag whole records across for two
 * booleans.
 */
const derivedState = {
  openItems: { select: { openItem: { select: { resolvedAt: true } } } },
  supersededBy: { select: { id: true } },
} as const;

/**
 * *Currently provisional*: true exactly when something the set rests on is
 * unresolved right now (ADR-0024's one column, read live).
 *
 * Derived on every read and stored nowhere. `issued_provisional` is the other
 * fact — that the set went out on unconfirmed inputs — and one column could
 * not be both: it would have to start lying about one of them the moment an
 * item resolved.
 */
function isCurrentlyProvisional(
  openItems: { openItem: { resolvedAt: Date | null } }[],
): boolean {
  return openItems.some((row) => row.openItem.resolvedAt === null);
}

/**
 * A submission on the wire carries both provisional facts, never one merged
 * into the other, and says whether it has been superseded.
 *
 * *Superseded* is a successor existing, derived here on every read. Storing it
 * would be the edit to the prior row that ADR-0015 forbids — the row a reissue
 * points at is never written to again (ADR-0026).
 */
function withDerivedState<
  T extends {
    openItems: { openItem: { resolvedAt: Date | null } }[];
    supersededBy: { id: string } | null;
  },
>(
  found: T,
): Omit<T, 'openItems' | 'supersededBy'> & {
  currentlyProvisional: boolean;
  supersededById: string | null;
} {
  const { openItems, supersededBy, ...submission } = found;
  return {
    ...submission,
    currentlyProvisional: isCurrentlyProvisional(openItems),
    supersededById: supersededBy === null ? null : supersededBy.id,
  };
}

/**
 * A submission the instant it was recorded. The two provisional facts
 * coincide at issuance, which is the only moment they ever have to, and
 * nothing can already point at a row created a moment ago.
 */
function asRecorded<T extends { issuedProvisional: boolean }>(submission: T) {
  return {
    ...submission,
    currentlyProvisional: submission.issuedProvisional,
    supersededById: null,
  };
}

/**
 * Enough of each link to tell the sets in a lineage apart on a screen. The
 * caller already holds the row it is asking about, so the walk is given it
 * rather than fetching it a second time.
 */
const chainSelect = {
  id: true,
  revision: true,
  issuedAt: true,
  recipient: true,
  recipientRole: true,
  issuedProvisional: true,
  supersedesId: true,
} as const;

type ChainLink = Prisma.SubmissionGetPayload<{ select: typeof chainSelect }>;

/**
 * The whole lineage a submission sits in, oldest issuance first, with the
 * current one marked (issue #7). Read from any link and it is the same list:
 * this is how "what is the current issuance of this?" is answered without
 * reading email.
 *
 * Walked a row at a time rather than in one recursive query. A chain is a
 * handful of issuances, and it terminates by construction — `supersedes_id`
 * is written once, pointing at a row that already existed, and no route ever
 * repoints it, so the links cannot form a cycle.
 */
async function supersedeChain(prisma: PrismaClient, found: ChainLink) {
  const chain: ChainLink[] = [found];

  // Back to the first issuance, by the column each successor carries.
  let older: string | null = found.supersedesId;
  while (older !== null) {
    const previous = await prisma.submission.findUnique({
      where: { id: older },
      select: chainSelect,
    });
    // A foreign key with nothing deleting submissions, so this is unreachable.
    if (previous === null) {
      break;
    }
    chain.unshift(previous);
    older = previous.supersedesId;
  }

  // Forward to the current one, by the unique back-reference — which is what
  // makes the chain linear: at most one row can name any given predecessor.
  let newer = found.id;
  for (;;) {
    const next = await prisma.submission.findUnique({
      where: { supersedesId: newer },
      select: chainSelect,
    });
    if (next === null) {
      break;
    }
    chain.push(next);
    newer = next.id;
  }

  return chain.map((entry, index) => ({
    ...entry,
    current: index === chain.length - 1,
  }));
}

/**
 * A submission about to be recorded, whichever route is recording it. Named
 * for the record and not for the act: "issuance" is the moment, and this is
 * the thing that goes into the table.
 */
interface NewSubmission {
  projectId: string;
  phaseId: string;
  issuedAt?: string;
  recipient: string;
  recipientRole: string;
  revision: string;
  sheetList: string;
  openItemIds: string[];
  /** The submission this one replaces, or null when it replaces nothing. */
  supersedesId: string | null;
}

/** The checks a submission goes through before anything is written. */
async function issuanceRefusal(
  prisma: PrismaClient,
  { projectId, phaseId, openItemIds }: NewSubmission,
): Promise<Refusal | null> {
  const badPhase = await phaseRefusal(prisma, phaseId, projectId);
  if (badPhase !== null) {
    return badPhase;
  }

  if (new Set(openItemIds).size !== openItemIds.length) {
    return {
      code: 409,
      message: 'an open item can only be named once on a submission',
    };
  }
  for (const openItemId of openItemIds) {
    const badItem = await openItemRefusal(prisma, openItemId, projectId);
    if (badItem !== null) {
      return badItem;
    }
  }
  return null;
}

/**
 * One transaction, so a submission never exists having lost the record of
 * what it rests on — and so the snapshot is taken at the same instant as the
 * row. The open items are re-read inside it rather than reused from the
 * checks above: a resolve landing in between would otherwise be stamped into
 * history as though it had happened first.
 */
function writeIssuance(
  prisma: PrismaClient,
  timeSource: TimeSource,
  { openItemIds, issuedAt, ...row }: NewSubmission,
) {
  return prisma.$transaction(async (tx) => {
    const named = await tx.openItem.findMany({
      where: { id: { in: openItemIds } },
      select: { id: true, resolvedAt: true },
    });
    const unresolvedThen = new Map(
      named.map((item) => [item.id, item.resolvedAt === null]),
    );

    const created = await tx.submission.create({
      data: {
        ...row,
        issuedAt: instant(issuedAt, timeSource),
        createdAt: timeSource.now(),
        // The permanent fact that the set went out on unconfirmed inputs.
        // Nothing recomputes it afterwards, and a reissue stamps its own
        // rather than copying the one it supersedes.
        issuedProvisional: named.some((item) => item.resolvedAt === null),
      },
    });
    if (openItemIds.length > 0) {
      await tx.submissionOpenItem.createMany({
        data: openItemIds.map((openItemId) => ({
          submissionId: created.id,
          openItemId,
          // Every id was checked to exist above; the fallback is unreachable
          // and here so an `undefined` can never land as the null that means
          // "attached afterwards".
          unresolvedAtIssuance: unresolvedThen.get(openItemId) ?? false,
        })),
      });
    }
    return created;
  });
}

export function buildServer({
  prisma,
  queue,
  timeSource = systemTimeSource,
  logger = false,
}: ServerDependencies): FastifyInstance {
  const app = Fastify({
    logger,
    // Fastify's ajv defaults to `removeAdditional: true`, which silently
    // strips an unknown field instead of failing the request. A body carrying
    // `owner` would then look accepted while the field vanished — so
    // `additionalProperties: false` is made to mean what it says.
    ajv: { customOptions: { removeAdditional: false } },
  });

  app.register(
    async (v1) => {
      /**
       * 200 means PostgreSQL and the queue's Redis both answered; either
       * failing rejects and Fastify returns 500. The body carries only what
       * varies, so there is nothing here that reads as a status but can never
       * be anything other than "ok".
       */
      v1.get('/health', async () => {
        const [, jobs] = await Promise.all([
          prisma.$queryRaw`SELECT 1`,
          queue.getJobCounts('waiting', 'active'),
        ]);

        return {
          queue: { name: queue.name, ...jobs },
          now: timeSource.now().toISOString(),
        };
      });

      v1.post<{ Body: { projectNumber: string; name: string } }>(
        '/projects',
        { schema: { body: projectBodySchema } },
        async (request, reply) => {
          try {
            const project = await prisma.project.create({
              data: { ...request.body, createdAt: timeSource.now() },
            });
            return reply.code(201).send(project);
          } catch (error) {
            if (isUniqueViolation(error)) {
              return reply
                .code(409)
                .send({ message: 'that project number is already in use' });
            }
            throw error;
          }
        },
      );

      /**
       * Live projects by default; `?archived=true` for the finished ones, which
       * is how an archived record stays reachable without a memorised URL.
       *
       * Ordered by creation, not by project number: the plan fixes no order,
       * and sorting the number as text puts `T-10` above `T-2`.
       */
      v1.get<{ Querystring: { archived: boolean } }>(
        '/projects',
        { schema: { querystring: listQuerySchema } },
        (request) =>
          prisma.project.findMany({
            where: request.query.archived
              ? { archivedAt: { not: null } }
              : { archivedAt: null },
            orderBy: { createdAt: 'asc' },
          }),
      );

      /** Archived projects are readable here; only the list hides them. */
      v1.get<{ Params: { id: string } }>(
        '/projects/:id',
        async (request, reply) => {
          const project = await prisma.project.findUnique({
            where: { id: request.params.id },
          });
          return project === null ? noSuchProject(reply) : project;
        },
      );

      /**
       * Archiving is one-way and stamped once. `updateMany` narrowed to the
       * unarchived row is what makes the second call a no-op rather than a
       * restamp — the date a job finished is a fact, not a last-touched time.
       */
      v1.post<{ Params: { id: string } }>(
        '/projects/:id/archive',
        async (request, reply) => {
          const { id } = request.params;
          await prisma.project.updateMany({
            where: { id, archivedAt: null },
            data: { archivedAt: timeSource.now() },
          });

          const project = await prisma.project.findUnique({ where: { id } });
          return project === null ? noSuchProject(reply) : project;
        },
      );

      /**
       * An open item is attached to a subject, not owned by one: the column
       * pair is polymorphic, so there is no foreign key and the subject is
       * checked here instead.
       */
      v1.post<{
        Params: { id: string };
        Body: {
          unresolved: string;
          blocks: string;
          waitingOn: string | null;
          waitingSince?: string;
          invalidationTrigger?: string;
          counterfactual: string;
          owner?: string;
        };
      }>(
        '/projects/:id/open-items',
        { schema: { body: openItemBodySchema } },
        async (request, reply) => {
          const project = await prisma.project.findUnique({
            where: { id: request.params.id },
            select: { id: true },
          });
          if (project === null) {
            return noSuchProject(reply);
          }

          const { waitingSince, ...rest } = request.body;
          const item = await prisma.openItem.create({
            data: {
              ...rest,
              subjectType: 'PROJECT',
              subjectId: project.id,
              waitingSince: instant(waitingSince, timeSource),
            },
          });
          return reply.code(201).send(item);
        },
      );

      /**
       * One project's open items. Unresolved by default; `?resolved=true` is
       * how a resolved item stays visible on the artifact it was attached to,
       * rather than disappearing the moment it is answered.
       */
      v1.get<{ Params: { id: string }; Querystring: { resolved: boolean } }>(
        '/projects/:id/open-items',
        { schema: { querystring: openItemListQuerySchema } },
        async (request, reply) => {
          const project = await prisma.project.findUnique({
            where: { id: request.params.id },
            select: { id: true },
          });
          if (project === null) {
            return noSuchProject(reply);
          }

          return prisma.openItem.findMany({
            where: {
              subjectType: 'PROJECT',
              subjectId: project.id,
              resolvedAt: request.query.resolved ? { not: null } : null,
            },
            orderBy: { waitingSince: 'asc' },
          });
        },
      );

      /**
       * The pending items view: every unresolved open item across every
       * project, oldest first, because the age is the reason to look at it.
       *
       * Archived projects are included. The glossary drops them from the live
       * project list and from the daily counts, neither of which this is —
       * and an unresolved item on a finished job is exactly the thing that
       * would otherwise be lost.
       */
      v1.get<{ Querystring: { waitingOn?: string; sort: 'oldest' | 'newest' } }>(
        '/open-items',
        { schema: { querystring: pendingQuerySchema } },
        async (request) => {
          const { waitingOn, sort } = request.query;

          const items = await prisma.openItem.findMany({
            where: {
              resolvedAt: null,
              ...(waitingOn === undefined
                ? {}
                : { waitingOn: meansNobody(waitingOn) ? null : waitingOn }),
            },
            orderBy: { waitingSince: sort === 'newest' ? 'desc' : 'asc' },
          });

          // A polymorphic subject cannot be joined, and the view is unusable
          // without knowing which job each item is on — so the subjects are
          // fetched once and attached.
          const projects = await prisma.project.findMany({
            where: { id: { in: items.map((item) => item.subjectId) } },
            select: { id: true, projectNumber: true, name: true },
          });
          const byId = new Map(projects.map((p) => [p.id, p]));

          return items.map((item) => ({
            ...item,
            project: byId.get(item.subjectId) ?? null,
          }));
        },
      );

      /**
       * Resolving is refused rather than repeated. A second resolve would
       * otherwise overwrite the first note silently, and the reason an item
       * was closed is the part worth keeping.
       */
      v1.post<{ Params: { id: string }; Body: { note: string; resolvedAt?: string } }>(
        '/open-items/:id/resolve',
        { schema: { body: resolveBodySchema } },
        async (request, reply) => {
          const { id } = request.params;
          const item = await prisma.openItem.findUnique({ where: { id } });
          if (item === null) {
            return noSuchOpenItem(reply);
          }
          if (item.resolvedAt !== null) {
            return reply
              .code(409)
              .send({ message: 'that open item is already resolved' });
          }

          return prisma.openItem.update({
            where: { id },
            data: {
              resolutionNote: request.body.note,
              resolvedAt: instant(request.body.resolvedAt, timeSource),
            },
          });
        },
      );

      /** For the item whose answer turned out to be wrong. */
      v1.post<{ Params: { id: string } }>(
        '/open-items/:id/reopen',
        async (request, reply) => {
          const { id } = request.params;
          const item = await prisma.openItem.findUnique({ where: { id } });
          if (item === null) {
            return noSuchOpenItem(reply);
          }
          if (item.resolvedAt === null) {
            return reply
              .code(409)
              .send({ message: 'that open item is not resolved' });
          }

          return prisma.openItem.update({
            where: { id },
            data: { resolvedAt: null, resolutionNote: null },
          });
        },
      );

      /**
       * Phases are rows on a project, never an enum: some jobs run 50% CD and
       * others go straight to 90% CD, so there is no set to share across them
       * (ADR-0015). A new one lands at the end of the list.
       */
      v1.post<{ Params: { id: string }; Body: { name: string } }>(
        '/projects/:id/phases',
        { schema: { body: phaseBodySchema } },
        async (request, reply) => {
          const project = await prisma.project.findUnique({
            where: { id: request.params.id },
            select: { id: true },
          });
          if (project === null) {
            return noSuchProject(reply);
          }

          try {
            const phase = await prisma.projectPhase.create({
              data: {
                projectId: project.id,
                name: request.body.name,
                position: await prisma.projectPhase.count({
                  where: { projectId: project.id },
                }),
              },
            });
            return reply.code(201).send(phase);
          } catch (error) {
            if (isUniqueViolation(error)) {
              return reply
                .code(409)
                .send({ message: 'that phase name is already on this project' });
            }
            throw error;
          }
        },
      );

      v1.get<{ Params: { id: string } }>(
        '/projects/:id/phases',
        async (request, reply) => {
          const project = await prisma.project.findUnique({
            where: { id: request.params.id },
            select: { id: true },
          });
          if (project === null) {
            return noSuchProject(reply);
          }

          return prisma.projectPhase.findMany({
            where: { projectId: project.id },
            orderBy: { position: 'asc' },
          });
        },
      );

      /**
       * Renaming propagates to every submission issued at this phase, because
       * a rename is the same body of work under a better name. A set that
       * went out at a different stage is a different phase (ADR-0026).
       */
      v1.post<{ Params: { id: string }; Body: { name: string } }>(
        '/phases/:id/rename',
        { schema: { body: phaseBodySchema } },
        async (request, reply) => {
          const { id } = request.params;
          const phase = await prisma.projectPhase.findUnique({ where: { id } });
          if (phase === null) {
            return noSuchPhase(reply);
          }

          try {
            return await prisma.projectPhase.update({
              where: { id },
              data: { name: request.body.name },
            });
          } catch (error) {
            if (isUniqueViolation(error)) {
              return reply
                .code(409)
                .send({ message: 'that phase name is already on this project' });
            }
            throw error;
          }
        },
      );

      /**
       * The whole ordered list, or nothing. A partial list would silently
       * leave a phase at a stale position and a repeated id would give two
       * phases the same place, so both are refused rather than absorbed.
       */
      v1.post<{ Params: { id: string }; Body: { phaseIds: string[] } }>(
        '/projects/:id/phases/order',
        { schema: { body: phaseOrderBodySchema } },
        async (request, reply) => {
          const project = await prisma.project.findUnique({
            where: { id: request.params.id },
            select: { id: true },
          });
          if (project === null) {
            return noSuchProject(reply);
          }

          const { phaseIds } = request.body;
          const existing = await prisma.projectPhase.findMany({
            where: { projectId: project.id },
            select: { id: true },
          });
          const known = new Set(existing.map((phase) => phase.id));
          const named = new Set(phaseIds);
          if (
            named.size !== phaseIds.length ||
            named.size !== known.size ||
            phaseIds.some((phaseId) => !known.has(phaseId))
          ) {
            return reply.code(409).send({
              message: "an order must name exactly this project's phases, once each",
            });
          }

          await prisma.$transaction(
            phaseIds.map((phaseId, position) =>
              prisma.projectPhase.update({
                where: { id: phaseId },
                data: { position },
              }),
            ),
          );

          return prisma.projectPhase.findMany({
            where: { projectId: project.id },
            orderBy: { position: 'asc' },
          });
        },
      );

      /**
       * The first route that updates a project. The project *number* is what
       * the glossary makes immutable, and it still is — this writes the phase
       * a new submission defaults to (ADR-0026).
       */
      v1.post<{ Params: { id: string }; Body: { phaseId: string } }>(
        '/projects/:id/current-phase',
        { schema: { body: currentPhaseBodySchema } },
        async (request, reply) => {
          const { id } = request.params;
          const project = await prisma.project.findUnique({
            where: { id },
            select: { id: true },
          });
          if (project === null) {
            return noSuchProject(reply);
          }

          const badPhase = await phaseRefusal(
            prisma,
            request.body.phaseId,
            project.id,
          );
          if (badPhase !== null) {
            return refuse(reply, badPhase);
          }

          return prisma.project.update({
            where: { id },
            data: { currentPhaseId: request.body.phaseId },
          });
        },
      );

      /**
       * Recording an issuance. There is no draft state and no route that
       * edits one afterwards: a correction is a reissue that supersedes
       * (ADR-0015), which is issue #7.
       */
      v1.post<{
        Params: { id: string };
        Body: {
          phaseId?: string;
          issuedAt?: string;
          recipient: string;
          recipientRole: string;
          revision: string;
          sheetList: string;
          openItemIds?: string[];
        };
      }>(
        '/projects/:id/submissions',
        { schema: { body: submissionBodySchema } },
        async (request, reply) => {
          const project = await prisma.project.findUnique({
            where: { id: request.params.id },
            select: { id: true, currentPhaseId: true },
          });
          if (project === null) {
            return noSuchProject(reply);
          }

          const { phaseId, issuedAt, openItemIds = [], ...rest } = request.body;
          const wanted = phaseId ?? project.currentPhaseId;
          if (wanted === null || wanted === undefined) {
            return reply.code(409).send({
              message: 'this project has no phase to issue at yet',
            });
          }

          const toIssue: NewSubmission = {
            ...rest,
            projectId: project.id,
            phaseId: wanted,
            issuedAt,
            openItemIds,
            // A first issuance replaces nothing. Correcting one is the
            // reissue route below, never a second create.
            supersedesId: null,
          };

          const bad = await issuanceRefusal(prisma, toIssue);
          if (bad !== null) {
            return refuse(reply, bad);
          }

          const submission = await writeIssuance(prisma, timeSource, toIssue);
          return reply.code(201).send(asRecorded(submission));
        },
      );

      /**
       * Reissue: correcting or reconsidering an issuance is a *new*
       * submission that points at the one it replaces (ADR-0015, issue #7).
       *
       * Nothing about the predecessor is written. It stays exactly as it went
       * out, and *superseded* is this row existing — derived on every read,
       * because storing it would be the edit to the prior row that the whole
       * decision forbids.
       */
      v1.post<{
        Params: { id: string };
        Body: {
          phaseId?: string;
          issuedAt?: string;
          recipient: string;
          recipientRole: string;
          revision: string;
          sheetList: string;
          openItemIds?: string[];
        };
      }>(
        '/submissions/:id/reissue',
        { schema: { body: submissionBodySchema } },
        async (request, reply) => {
          const superseded = await prisma.submission.findUnique({
            where: { id: request.params.id },
            select: {
              id: true,
              projectId: true,
              phaseId: true,
              supersededBy: { select: { id: true } },
              openItems: { select: { openItemId: true } },
            },
          });
          if (superseded === null) {
            return noSuchSubmission(reply);
          }
          // The unique index says this too, and says it under a race. Asked
          // here so the ordinary answer is the sentence rather than a 500.
          if (superseded.supersededBy !== null) {
            return alreadySuperseded(reply);
          }

          const { phaseId, issuedAt, openItemIds, ...rest } = request.body;
          const toIssue: NewSubmission = {
            ...rest,
            projectId: superseded.projectId,
            // Another issuance of the same set, at the same stage unless the
            // reissue says otherwise. Defaulting to the project's current
            // phase would quietly move a correction to wherever the job has
            // got to since.
            phaseId: phaseId ?? superseded.phaseId,
            issuedAt,
            // Left off entirely, what the superseded set rested on carries
            // forward — a reissue must never silently lose the dependencies
            // the original stood on. A supplied list is exactly that list,
            // which is how one is dropped before committing, so `[]` is a
            // deliberate drop rather than an omission.
            openItemIds:
              openItemIds ?? superseded.openItems.map((row) => row.openItemId),
            supersedesId: superseded.id,
          };

          const bad = await issuanceRefusal(prisma, toIssue);
          if (bad !== null) {
            return refuse(reply, bad);
          }

          try {
            const reissued = await writeIssuance(prisma, timeSource, toIssue);
            return reply.code(201).send(asRecorded(reissued));
          } catch (error) {
            // Narrowed to the supersede column: anything else colliding here
            // is a state this route does not understand, and a 500 is the
            // honest answer to it.
            if (violates(error, 'supersedes_id')) {
              return alreadySuperseded(reply);
            }
            throw error;
          }
        },
      );

      /**
       * Issuance order, oldest first: this is a chronicle of what went out.
       * Entry order breaks a tie, so two sets issued on the same day do not
       * come back in an arbitrary one.
       */
      v1.get<{ Params: { id: string } }>(
        '/projects/:id/submissions',
        async (request, reply) => {
          const project = await prisma.project.findUnique({
            where: { id: request.params.id },
            select: { id: true },
          });
          if (project === null) {
            return noSuchProject(reply);
          }

          const listed = await prisma.submission.findMany({
            where: { projectId: project.id },
            orderBy: [{ issuedAt: 'asc' }, { createdAt: 'asc' }],
            include: derivedState,
          });
          return listed.map(withDerivedState);
        },
      );

      /**
       * One submission, with the phase it was issued at, the job it belongs
       * to, and what it rests on. The open items come through the join rather
       * than through their subject, which is what lets one item back several
       * issuances and lets a resolved one stay on the set it went out with
       * (ADR-0026).
       */
      v1.get<{ Params: { id: string } }>(
        '/submissions/:id',
        async (request, reply) => {
          const found = await prisma.submission.findUnique({
            where: { id: request.params.id },
            include: {
              phase: true,
              project: {
                select: { id: true, projectNumber: true, name: true },
              },
              supersededBy: { select: { id: true } },
              openItems: {
                include: { openItem: true },
                orderBy: { openItem: { waitingSince: 'asc' } },
              },
            },
          });
          if (found === null) {
            return noSuchSubmission(reply);
          }

          const { openItems, supersededBy, ...submission } = found;
          return {
            ...submission,
            currentlyProvisional: isCurrentlyProvisional(openItems),
            supersededById: supersededBy === null ? null : supersededBy.id,
            // The whole lineage this set sits in, so the current issuance is
            // answerable from any link in it (issue #7).
            chain: await supersedeChain(prisma, found),
            // Where each item stood when the set went out, carried on the
            // item itself: null for one attached afterwards.
            openItems: openItems.map((row) => ({
              ...row.openItem,
              unresolvedAtIssuance: row.unresolvedAtIssuance,
            })),
          };
        },
      );

      /**
       * Exposure: the issued submissions currently carrying unresolved open
       * items — one of the two uncombined counts that replaced the health
       * score (ADR-0016). Every project's, or one project's with `projectId`.
       *
       * A list, not a number. The count is its length, so clicking a count and
       * landing on the rows it counted cannot show a different set — and there
       * is nothing here to combine with a second figure into a score.
       *
       * Archived projects drop out of the count across every project, because
       * exposure is one of the daily counts and a finished job is not part of
       * today's work (glossary, **Pending items**). Asked about one job
       * directly, its own record still answers.
       */
      v1.get<{ Querystring: { projectId?: string } }>(
        '/exposure',
        { schema: { querystring: exposureQuerySchema } },
        async (request, reply) => {
          const { projectId } = request.query;
          if (projectId !== undefined) {
            const project = await prisma.project.findUnique({
              where: { id: projectId },
              select: { id: true },
            });
            // Nothing to act on and no such job are not the same answer, and
            // an empty list would read as the first.
            if (project === null) {
              return noSuchProject(reply);
            }
          }

          const carrying = await prisma.submission.findMany({
            where: {
              openItems: { some: { openItem: { resolvedAt: null } } },
              // Superseded ancestors are not what is out there. A reissue
              // carries the same unresolved items forward, so without this
              // every correction would count its set twice (issue #7).
              supersededBy: { is: null },
              ...(projectId === undefined
                ? { project: { archivedAt: null } }
                : { projectId }),
            },
            orderBy: [{ issuedAt: 'asc' }, { createdAt: 'asc' }],
            include: {
              phase: true,
              project: { select: { id: true, projectNumber: true, name: true } },
              ...derivedState,
            },
          });
          return carrying.map(withDerivedState);
        },
      );

      /**
       * An open item raised while recording an issuance. Its subject is the
       * project, not the submission — an item that vanished from the project
       * screen the moment it was tied to a set would be the opposite of
       * "nothing sitting in my court" (ADR-0026).
       */
      v1.post<{
        Params: { id: string };
        Body: {
          unresolved: string;
          blocks: string;
          waitingOn: string | null;
          waitingSince?: string;
          invalidationTrigger?: string;
          counterfactual: string;
          owner?: string;
        };
      }>(
        '/submissions/:id/open-items',
        { schema: { body: openItemBodySchema } },
        async (request, reply) => {
          const submission = await prisma.submission.findUnique({
            where: { id: request.params.id },
            select: { id: true, projectId: true },
          });
          if (submission === null) {
            return noSuchSubmission(reply);
          }

          const { waitingSince, ...rest } = request.body;
          const item = await prisma.openItem.create({
            data: {
              ...rest,
              subjectType: 'PROJECT',
              subjectId: submission.projectId,
              waitingSince: instant(waitingSince, timeSource),
              submissions: { create: { submissionId: submission.id } },
            },
          });
          return reply.code(201).send(item);
        },
      );

      /**
       * Attaching an item that is already on the set is refused rather than
       * repeated, matching the resolve rule: a silent second attach would
       * hide a double click behind a claim about what an issuance rested on.
       */
      v1.post<{ Params: { id: string; openItemId: string } }>(
        '/submissions/:id/open-items/:openItemId',
        async (request, reply) => {
          const { id, openItemId } = request.params;
          const submission = await prisma.submission.findUnique({
            where: { id },
            select: { id: true, projectId: true },
          });
          if (submission === null) {
            return noSuchSubmission(reply);
          }

          const badItem = await openItemRefusal(
            prisma,
            openItemId,
            submission.projectId,
          );
          if (badItem !== null) {
            return refuse(reply, badItem);
          }

          try {
            await prisma.submissionOpenItem.create({
              data: { submissionId: submission.id, openItemId },
            });
          } catch (error) {
            if (isUniqueViolation(error)) {
              return reply.code(409).send({
                message: 'that open item is already on this submission',
              });
            }
            throw error;
          }
          return reply.code(204).send();
        },
      );

      /**
       * Detaching says nothing about the open item, which stays on its
       * project. An item attached to the wrong set is a typo, and the
       * alternative is an unremovable claim about what went out.
       *
       * Narrowed to items attached *after* the issuance. The snapshot of what
       * was unresolved at that moment lives on these rows, so deleting one the
       * set was issued resting on would erase the record by cleanup — the
       * collision ADR-0026 recorded for this ticket to settle.
       */
      v1.delete<{ Params: { id: string; openItemId: string } }>(
        '/submissions/:id/open-items/:openItemId',
        async (request, reply) => {
          const { id, openItemId } = request.params;
          const submission = await prisma.submission.findUnique({
            where: { id },
            select: { id: true },
          });
          if (submission === null) {
            return noSuchSubmission(reply);
          }

          const key = { submissionId_openItemId: { submissionId: id, openItemId } };
          const attached = await prisma.submissionOpenItem.findUnique({
            where: key,
            select: { unresolvedAtIssuance: true },
          });
          // The submission exists, so a miss here is about the item: saying
          // "no submission with that id" would send the reader looking in
          // entirely the wrong place.
          if (attached === null) {
            return reply
              .code(404)
              .send({ message: 'that open item is not on this submission' });
          }
          if (attached.unresolvedAtIssuance !== null) {
            return reply.code(409).send({
              message: 'this submission was issued resting on that open item',
            });
          }

          await prisma.submissionOpenItem.delete({ where: key });
          return reply.code(204).send();
        },
      );
    },
    { prefix: API_PREFIX },
  );

  return app;
}
