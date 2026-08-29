import 'dotenv/config';
import { createRuntime } from './runtime.js';
import { buildServer } from './server.js';
import { systemTimeSource } from './time-source.js';
import { transcriberFromEnv } from './transcription.js';
import { buildWorker } from './worker.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. Copy apps/api/.env.example to apps/api/.env.`,
    );
  }
  return value;
}

function apiPort(): number {
  const raw = process.env['API_PORT'];
  if (raw === undefined || raw === '') {
    return 3001;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`API_PORT must be a port number, got ${raw}`);
  }
  return port;
}

const runtime = createRuntime({
  databaseUrl: requireEnv('DATABASE_URL'),
  redisUrl: requireEnv('REDIS_URL'),
  queueName: 'epmos',
  objectStoreDir: requireEnv('OBJECT_STORE_DIR'),
});

const app = buildServer({
  prisma: runtime.prisma,
  queue: runtime.queue,
  objectStore: runtime.objectStore,
  logger: true,
});

/**
 * The transcription worker, in this process (issue #12).
 *
 * One process for a single-user tool (ADR-0012), and the same dependencies
 * the server is handed — which is what lets the test harness run a real
 * worker over a real Redis without a second copy of this wiring. Splitting
 * it out is a deployment change and touches nothing above `worker.ts`.
 */
const worker = buildWorker({
  prisma: runtime.prisma,
  objectStore: runtime.objectStore,
  transcriber: transcriberFromEnv(),
  timeSource: systemTimeSource,
  connection: runtime.workerConnection,
  queueName: runtime.queueName,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void (async () => {
      await app.close();
      // Before the connections it is holding, and after the server, so a job
      // already running finishes rather than being abandoned mid-vendor-call.
      await worker.close();
      await runtime.close();
    })();
  });
}

await app.listen({ port: apiPort(), host: '127.0.0.1' });
