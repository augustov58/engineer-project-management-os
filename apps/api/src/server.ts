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
    },
    { prefix: API_PREFIX },
  );

  return app;
}
