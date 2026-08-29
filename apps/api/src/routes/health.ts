/** Is PostgreSQL answering, and is the queue's Redis (issue #2). */

import type { FastifyInstance } from 'fastify';
import type { RouteDependencies } from '../http.js';

export function healthRoutes(
  v1: FastifyInstance,
  { prisma, queue, timeSource }: RouteDependencies,
): void {
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

}
