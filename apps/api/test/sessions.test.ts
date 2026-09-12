/**
 * Signing in, signing out, and what a session is worth (issue #105, ADR-0055).
 *
 * `test/gate.test.ts` owns what the boundary does with one; this owns the
 * record itself.
 */

import { afterEach, expect, test } from 'vitest';
import { SESSION_HEADER } from '../src/gate.js';
import {
  fakeTimeSource,
  startTestApi,
  TEST_USER,
  type TestApi,
} from './harness.js';

const started: TestApi[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((instance) => instance.close()));
});

async function api(options: Parameters<typeof startTestApi>[0] = {}) {
  const app = await startTestApi({ worker: false, ...options });
  started.push(app);
  return app;
}

/** An anonymous caller, which is the only way to reach the sign-in route. */
function signIn(app: TestApi, body: unknown) {
  return fetch(`${app.baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('signing in answers a session and the person it belongs to', async () => {
  const clock = fakeTimeSource(new Date('2026-09-12T09:00:00.000Z'));
  const app = await api({ timeSource: clock });

  const response = await signIn(app, {
    email: TEST_USER.email,
    password: TEST_USER.password,
  });

  expect(response.status).toBe(201);
  const body = (await response.json()) as {
    id: string;
    expiresAt: string;
    user: Record<string, unknown>;
  };

  // A year from the injected clock, as the unlock cookie was: field use is a
  // phone inside a building and nothing may stand between the engineer and a
  // walk (ADR-0055).
  expect(body.expiresAt).toBe('2027-09-12T09:00:00.000Z');
  expect(body.user).toEqual({
    id: app.user.id,
    name: TEST_USER.name,
    email: TEST_USER.email,
  });
  // The projection is what keeps the hash off the wire, not each route
  // remembering to leave it out.
  expect(Object.keys(body.user).sort()).toEqual(['email', 'id', 'name']);

  const opens = await fetch(`${app.baseUrl}/v1/projects`, {
    headers: { [SESSION_HEADER]: body.id },
  });
  expect(opens.status).toBe(200);
});

test('a wrong password, an unknown address and no body at all are one refusal', async () => {
  const app = await api();

  const answers = [
    await signIn(app, { email: TEST_USER.email, password: 'not-the-password' }),
    await signIn(app, { email: 'nobody@example.test', password: TEST_USER.password }),
    await signIn(app, { email: TEST_USER.email }),
    await signIn(app, 'a string, which is not credentials'),
    await fetch(`${app.baseUrl}/v1/sessions`, { method: 'POST' }),
  ];

  for (const answer of answers) {
    expect(answer.status).toBe(401);
    expect(await answer.json()).toEqual({
      message: 'That is not an account here, or not its password.',
    });
  }
});

test('the session read names whoever the request came in as', async () => {
  const app = await api();

  const response = await app.fetch('/v1/sessions/current');

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    id: app.user.id,
    name: TEST_USER.name,
    email: TEST_USER.email,
  });
});

test('signing out revokes this session and leaves every other one alone', async () => {
  const app = await api();

  const other = (await (
    await signIn(app, { email: TEST_USER.email, password: TEST_USER.password })
  ).json()) as { id: string };

  expect((await app.fetch('/v1/sessions/current', { method: 'DELETE' })).status).toBe(204);

  expect((await app.fetch('/v1/sessions/current')).status).toBe(401);
  const still = await fetch(`${app.baseUrl}/v1/sessions/current`, {
    headers: { [SESSION_HEADER]: other.id },
  });
  expect(still.status).toBe(200);
});

test('signing in twice is two sessions, and neither is the other', async () => {
  const app = await api();

  const first = (await (
    await signIn(app, { email: TEST_USER.email, password: TEST_USER.password })
  ).json()) as { id: string };
  const second = (await (
    await signIn(app, { email: TEST_USER.email, password: TEST_USER.password })
  ).json()) as { id: string };

  expect(first.id).not.toBe(second.id);
  // A credential and not a record id: nothing shows it, and it is not the
  // shape of anything this product puts in a path (ADR-0055).
  expect(first.id).not.toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  expect(first.id.length).toBeGreaterThan(32);
});
