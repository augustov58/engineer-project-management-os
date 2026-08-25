import { PrismaPg } from '@prisma/adapter-pg';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { PrismaClient } from '../generated/prisma/client.js';

export interface Runtime {
  prisma: PrismaClient;
  queue: Queue;
  close(): Promise<void>;
}

export interface RuntimeOptions {
  databaseUrl: string;
  redisUrl: string;
  /** Distinct per test, so two suites never share a queue. */
  queueName: string;
}

/**
 * Everything the API needs that holds a connection open.
 *
 * Production and the test harness both build it here. That is what makes
 * "tests construct the server the way production does" true by construction,
 * rather than true only while two copies of the wiring stay in step.
 */
export function createRuntime({
  databaseUrl,
  redisUrl,
  queueName,
}: RuntimeOptions): Runtime {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });

  /** Wired and reachable. Nothing enqueues onto it yet. */
  const queue = new Queue(queueName, { connection: redis });

  return {
    prisma,
    queue,
    close: async () => {
      await queue.close();
      redis.disconnect();
      await prisma.$disconnect();
    },
  };
}
