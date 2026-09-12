/**
 * The people at the firm (issue #105, ADR-0055).
 *
 * The first account is made by a command on the machine — there is no route
 * that could make it, and the harness writes it directly for that reason. What
 * is driven here is everything after: any signed-in engineer adds the next
 * account, and closing one is recorded rather than prevented.
 */

import { afterEach, expect, test } from 'vitest';
import { startTestApi, TEST_USER, type TestApi } from './harness.js';

const started: TestApi[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((instance) => instance.close()));
});

async function api(options: Parameters<typeof startTestApi>[0] = {}) {
  const app = await startTestApi({ worker: false, ...options });
  started.push(app);
  return app;
}

const SECOND_ENGINEER = {
  name: 'Grace Hopper',
  email: 'grace@example.test',
  password: 'a-nanosecond-is-300mm',
};

function create(app: TestApi, body: unknown) {
  return app.fetch('/v1/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function signIn(app: TestApi, email: string, password: string) {
  return fetch(`${app.baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

test('a signed-in engineer adds the next account, and it can sign in', async () => {
  const app = await api();

  const response = await create(app, SECOND_ENGINEER);
  expect(response.status).toBe(201);
  const created = (await response.json()) as Record<string, unknown>;
  expect(created).toEqual({
    id: expect.any(String),
    name: SECOND_ENGINEER.name,
    email: SECOND_ENGINEER.email,
  });

  const listed = await app.fetch('/v1/users');
  expect(listed.status).toBe(200);
  expect((await listed.json()) as unknown[]).toEqual([
    { id: app.user.id, name: TEST_USER.name, email: TEST_USER.email },
    created,
  ]);

  const theirs = await signIn(
    app,
    SECOND_ENGINEER.email,
    SECOND_ENGINEER.password,
  );
  expect(theirs.status).toBe(201);
});

test('no password hash reaches the wire, on either read', async () => {
  const app = await api();
  await create(app, SECOND_ENGINEER);

  const listed = await (await app.fetch('/v1/users')).text();
  const read = await (await app.fetch('/v1/sessions/current')).text();

  for (const body of [listed, read]) {
    expect(body).not.toContain('passwordHash');
    expect(body).not.toContain('password_hash');
    expect(body).not.toContain('argon2');
    expect(body).not.toContain(SECOND_ENGINEER.password);
  }
});

test('an address can only have one account', async () => {
  const app = await api();
  expect((await create(app, SECOND_ENGINEER)).status).toBe(201);

  const again = await create(app, {
    ...SECOND_ENGINEER,
    name: 'Somebody Else',
  });

  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({
    message: 'that email address already has an account',
  });
});

test('a password shorter than the one rule there is refused', async () => {
  const app = await api();

  const response = await create(app, {
    ...SECOND_ENGINEER,
    // Eleven characters, one short of the only rule there is.
    password: 'short-one-1',
  });

  expect(response.status).toBe(400);
});

test('disabling an account closes it and every session it had', async () => {
  const app = await api();
  const created = (await (await create(app, SECOND_ENGINEER)).json()) as {
    id: string;
  };
  const theirs = (await (
    await signIn(app, SECOND_ENGINEER.email, SECOND_ENGINEER.password)
  ).json()) as { id: string };

  const disabled = await app.fetch(`/v1/users/${created.id}/disable`, {
    method: 'POST',
  });
  expect(disabled.status).toBe(200);

  // The phone in their pocket, not only the sign-in screen.
  const stale = await fetch(`${app.baseUrl}/v1/projects`, {
    headers: { 'x-session-id': theirs.id },
  });
  expect(stale.status).toBe(401);

  const again = await signIn(
    app,
    SECOND_ENGINEER.email,
    SECOND_ENGINEER.password,
  );
  expect(again.status).toBe(401);

  // A second disable is the same answer and writes no second line.
  expect(
    (await app.fetch(`/v1/users/${created.id}/disable`, { method: 'POST' }))
      .status,
  ).toBe(200);

  const missing = await app.fetch(
    '/v1/users/00000000-0000-4000-8000-000000000000/disable',
    { method: 'POST' },
  );
  expect(missing.status).toBe(404);
});

test("the firm's mutations are audited, and land on no job's trail", async () => {
  const app = await api();
  const project = await app.fetch('/v1/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectNumber: 'A-1',
      name: 'Riser replacement',
      timezone: 'America/New_York',
    }),
  });
  const { id: projectId } = (await project.json()) as { id: string };

  await create(app, SECOND_ENGINEER);
  await signIn(app, SECOND_ENGINEER.email, SECOND_ENGINEER.password);

  // Read through the export, which is the only route that returns a line
  // written about no project — both readers of the audit filter by job.
  const exported = (await (await app.fetch('/v1/export')).json()) as {
    records: { auditEntries: { projectId: string | null; action: string }[] };
  };
  const firmWide = exported.records.auditEntries.filter(
    (line) => line.projectId === null,
  );
  // Sorted, because the audit deliberately has no `seq` and nothing derives a
  // value from its order (ADR-0048). What is asserted is that both lines were
  // written and that neither carries a job.
  expect(firmWide.map((line) => line.action).sort()).toEqual([
    'signed in',
    'user recorded',
  ]);

  // And the job's own trail is exactly what happened to the job.
  const trail = (await (
    await app.fetch(`/v1/projects/${projectId}/memory/audit`)
  ).json()) as { action: string }[];
  expect(trail.map((line) => line.action)).toEqual(['project recorded']);
});
