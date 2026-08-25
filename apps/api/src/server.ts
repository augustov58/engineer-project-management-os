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

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === UNIQUE_VIOLATION
  );
}

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
    unresolved: { type: 'string', minLength: 1, maxLength: 500 },
    blocks: { type: 'string', minLength: 1, maxLength: 500 },
    // Null is nobody. A blank string is not — an empty field must never be a
    // way of saying that no one owes the next move (ADR-0014).
    waitingOn: { type: ['string', 'null'], minLength: 1, maxLength: 120 },
    // Optional so entry stays quick, and settable so a project's existing
    // items can be entered with the date they have actually been open since.
    waitingSince: { type: 'string', format: 'date-time' },
    invalidationTrigger: { type: 'string', minLength: 1, maxLength: 500 },
    counterfactual: { type: 'string', minLength: 1, maxLength: 1000 },
    owner: { type: 'string', minLength: 1, maxLength: 120 },
  },
} as const;

/** Resolving takes a note and a date; only the date may be left to the clock. */
const resolveBodySchema = {
  type: 'object',
  required: ['note'],
  additionalProperties: false,
  properties: {
    note: { type: 'string', minLength: 1, maxLength: 1000 },
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
    waitingOn: { type: 'string', minLength: 1, maxLength: 120 },
    sort: { type: 'string', enum: ['oldest', 'newest'], default: 'oldest' },
  },
} as const;

/**
 * The reserved filter value for "no one owes the next move". A blank
 * `waitingOn=` is rejected instead, so the two never collapse into each other.
 */
const NOBODY = 'nobody';

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
                : { waitingOn: waitingOn === NOBODY ? null : waitingOn }),
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
    },
    { prefix: API_PREFIX },
  );

  return app;
}
