import type { Queue } from 'bullmq';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PrismaClient } from '../generated/prisma/client.js';
import { systemTimeSource, type TimeSource } from './time-source.js';

export interface ServerDependencies {
  prisma: PrismaClient;
  queue: Queue;
  /** Defaults to the real clock; tests pass a fake and advance it by hand. */
  timeSource?: TimeSource;
  logger?: boolean;
}

const labelBodySchema = {
  type: 'object',
  required: ['label'],
  additionalProperties: false,
  properties: { label: { type: 'string', minLength: 1 } },
} as const;

export function buildServer({
  prisma,
  queue,
  timeSource = systemTimeSource,
  logger = false,
}: ServerDependencies): FastifyInstance {
  const app = Fastify({ logger });

  /**
   * 200 means PostgreSQL and the queue's Redis both answered; either failing
   * rejects and Fastify returns 500. The body carries only what varies, so
   * there is nothing here that reads as a status but can never be anything
   * other than "ok".
   */
  app.get('/health', async () => {
    const [, jobs] = await Promise.all([
      prisma.$queryRaw`SELECT 1`,
      queue.getJobCounts('waiting', 'active'),
    ]);

    return {
      queue: { name: queue.name, ...jobs },
      now: timeSource.now().toISOString(),
    };
  });

  app.post<{ Body: { label: string } }>(
    '/skeleton-records',
    { schema: { body: labelBodySchema } },
    async (request, reply) => {
      const record = await prisma.skeletonRecord.create({
        data: { label: request.body.label, createdAt: timeSource.now() },
      });
      return reply.code(201).send(record);
    },
  );

  app.get('/skeleton-records', () =>
    prisma.skeletonRecord.findMany({ orderBy: { createdAt: 'asc' } }),
  );

  return app;
}
