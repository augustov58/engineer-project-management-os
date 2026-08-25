import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { inject } from 'vitest';
import { createRuntime } from '../src/runtime.js';
import { buildServer } from '../src/server.js';
import type { TimeSource } from '../src/time-source.js';

export interface TestApi {
  /** Origin of a real listening HTTP server, e.g. `http://127.0.0.1:41234`. */
  baseUrl: string;
  /** `fetch` against this API. Tests assert on the response, nothing else. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

/**
 * Boots the API over its own freshly migrated PostgreSQL database and a real
 * Redis, and listens on a random port.
 *
 * Every call copies the migrated template database, so tests never share
 * state and never need to clean up after each other. Nothing here is mocked
 * or substituted: the only injectable is the time source, which is the one
 * seam the plan names.
 */
export async function startTestApi(
  options: { timeSource?: TimeSource } = {},
): Promise<TestApi> {
  const adminUrl = inject('postgresAdminUrl');
  const database = `test_${randomBytes(8).toString('hex')}`;

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(
    `CREATE DATABASE "${database}" TEMPLATE "${inject('templateDatabase')}"`,
  );
  await admin.end();

  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${database}`;

  const runtime = createRuntime({
    databaseUrl: databaseUrl.toString(),
    redisUrl: inject('redisUrl'),
    queueName: `skeleton-${database}`,
  });

  const app = buildServer({
    prisma: runtime.prisma,
    queue: runtime.queue,
    timeSource: options.timeSource,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });

  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected the test API to be listening on a TCP port');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    fetch: (path, init) => fetch(`${baseUrl}${path}`, init),
    close: async () => {
      await app.close();
      await runtime.close();

      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

/** A time source the test moves by hand, so aging is tested without sleeping. */
export function fakeTimeSource(start: Date) {
  let current = start;
  return {
    now: () => current,
    advance: (milliseconds: number) => {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

/** Fixtures are built through the API, never by writing to the database. */
export async function createSkeletonRecord(api: TestApi, label: string) {
  const response = await api.fetch('/skeleton-records', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  if (response.status !== 201) {
    throw new Error(
      `fixture failed: POST /skeleton-records returned ${response.status}`,
    );
  }
  return (await response.json()) as { id: string; label: string; createdAt: string };
}
