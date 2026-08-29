import { PrismaPg } from '@prisma/adapter-pg';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { PrismaClient } from '../generated/prisma/client.js';
import { FilesystemObjectStore, type ObjectStore } from './object-store.js';

export interface Runtime {
  prisma: PrismaClient;
  queue: Queue;
  objectStore: ObjectStore;
  /** What the worker listens on, which is what the queue writes to. */
  queueName: string;
  /**
   * A second Redis, for the transcription worker (issue #12).
   *
   * Not the queue's. A BullMQ `Worker` waits on the list with a blocking
   * command and holds the connection for the duration, so sharing one would
   * park every `queue.add` behind whatever the worker is waiting for.
   */
  workerConnection: Redis;
  close(): Promise<void>;
}

export interface RuntimeOptions {
  databaseUrl: string;
  redisUrl: string;
  /** Distinct per test, so two suites never share a queue. */
  queueName: string;
  /** Where a photograph's bytes go. Distinct per test, like the queue name. */
  objectStoreDir: string;
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
  objectStoreDir,
}: RuntimeOptions): Runtime {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const workerRedis = new Redis(redisUrl, { maxRetriesPerRequest: null });

  /** Transcription is the one thing on it (issue #12). */
  const queue = new Queue(queueName, { connection: redis });

  return {
    prisma,
    queue,
    objectStore: new FilesystemObjectStore(objectStoreDir),
    queueName,
    workerConnection: workerRedis,
    close: async () => {
      await queue.close();
      redis.disconnect();
      workerRedis.disconnect();
      await prisma.$disconnect();
    },
  };
}
