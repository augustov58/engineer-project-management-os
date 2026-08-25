import 'dotenv/config';
import { createRuntime } from './runtime.js';
import { buildServer } from './server.js';

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
});

const app = buildServer({
  prisma: runtime.prisma,
  queue: runtime.queue,
  logger: true,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void (async () => {
      await app.close();
      await runtime.close();
    })();
  });
}

await app.listen({ port: apiPort(), host: '127.0.0.1' });
