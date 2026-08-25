import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';

const run = promisify(execFile);

/** Database that migrations are applied to once; every test copies it. */
const TEMPLATE_DATABASE = 'epmos_template';

declare module 'vitest' {
  interface ProvidedContext {
    postgresAdminUrl: string;
    templateDatabase: string;
    redisUrl: string;
  }
}

/**
 * One ephemeral PostgreSQL and one ephemeral Redis per test run.
 *
 * The template database is migrated with `prisma migrate deploy`, from the
 * same `prisma/migrations` directory production deploys — not `db push`, and
 * not a schema built by the test.
 */
export default async function setup({ provide }: TestProject) {
  const [postgres, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase(TEMPLATE_DATABASE)
      .start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);

  const templateUrl = postgres.getConnectionUri();

  await run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, DATABASE_URL: templateUrl },
  });

  const adminUrl = new URL(templateUrl);
  adminUrl.pathname = '/postgres';

  provide('postgresAdminUrl', adminUrl.toString());
  provide('templateDatabase', TEMPLATE_DATABASE);
  provide('redisUrl', redis.getConnectionUrl());

  return async () => {
    await Promise.all([postgres.stop(), redis.stop()]);
  };
}
