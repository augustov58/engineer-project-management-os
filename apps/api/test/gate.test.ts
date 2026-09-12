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

/**
 * The one route the gate lets through with nothing at all, named the way the
 * hook names it (ADR-0020, kept by name by ADR-0055). Inbound mail cannot
 * present a session: the provider posts to an address, and the address's own
 * unguessability and the rate limit beneath it are what stand in the gate's
 * place there (ADR-0042).
 *
 * `POST /v1/sessions` is **not** here and is not a second exemption: it
 * presents an email and a password instead of a session and refuses with the
 * same 401 the gate does, which is why the sweep below reads it as refused.
 * The test after the sweep is what proves it reached its own handler to do so.
 */
const EXEMPT = { method: 'POST', url: '/v1/ingest/inbound-mail' };

/**
 * A concrete URL for a route pattern. Which id it is does not matter: the
 * gate runs at `onRequest`, before a schema or a lookup ever sees the value,
 * so a route refuses an anonymous caller identically for a real id and an
 * invented one — which is the point being asserted.
 */
function concrete(url: string): string {
  return url.replace(
    /:[A-Za-z]+/g,
    '00000000-0000-4000-8000-000000000000',
  );
}

test('every route the API registers refuses a request carrying no session, and the ingest webhook is the only one that does not', async () => {
  const app = await startTestApi({ worker: false });
  started.push(app);

  const routes = app.routes();
  // A guard on the sweep itself: if this ever collects nothing, every
  // assertion below would pass by vacuity and the gate would be untested.
  expect(routes.length).toBeGreaterThan(100);

  const refused: string[] = [];
  const allowed: string[] = [];

  for (const route of routes) {
    const response = await fetch(`${app.baseUrl}${concrete(route.url)}`, {
      method: route.method,
    });
    const where = `${route.method} ${route.url}`;
    (response.status === 401 ? refused : allowed).push(where);
    // Nothing is read off the body; a hijacked stream would otherwise hold
    // this open, and a refusal happens before any route hijacks.
    await response.body?.cancel();
  }

  expect(allowed).toEqual([`${EXEMPT.method} ${EXEMPT.url}`]);
  expect(refused.length).toBe(routes.length - 1);
});

test('the sign-in route is refused by the sweep because it answers, not because the gate did', async () => {
  const app = await startTestApi({ worker: false });
  started.push(app);

  // The same request the sweep makes: no session, no body, no content type.
  // The gate steps aside and the route itself refuses — which is how the
  // one-exempt-route property above survives there being a way in at all.
  const response = await fetch(`${app.baseUrl}/v1/sessions`, {
    method: 'POST',
  });

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({
    message: 'That is not an account here, or not its password.',
  });
});

test('the refusal says what is wrong and nothing about the record behind it', async () => {
  const app = await startTestApi({ worker: false });
  started.push(app);

  const response = await fetch(`${app.baseUrl}/v1/projects`);

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ message: 'Not signed in.' });
});

test('a session id that is not one is refused exactly as none is', async () => {
  const app = await startTestApi({ worker: false });
  started.push(app);

  for (const presented of [
    `${app.sessionId}x`,
    app.sessionId.slice(0, -1),
    '',
  ]) {
    const response = await fetch(`${app.baseUrl}/v1/projects`, {
      headers: { [SESSION_HEADER]: presented },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message: 'Not signed in.' });
  }
});

test('a revoked session stops opening anything, and the others stay open', async () => {
  const app = await startTestApi({ worker: false });
  started.push(app);

  // A second session for the same person, obtained the way a second device
  // would obtain one.
  const signIn = await fetch(`${app.baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: TEST_USER.email,
      password: TEST_USER.password,
    }),
  });
  expect(signIn.status).toBe(201);
  const second = (await signIn.json()) as { id: string };

  const out = await app.fetch('/v1/sessions/current', { method: 'DELETE' });
  expect(out.status).toBe(204);

  // The one that signed out is gone.
  expect((await app.fetch('/v1/projects')).status).toBe(401);
  // The other one is not: revocation is per row, which is the property the
  // shared secret never had (ADR-0055).
  const stillIn = await fetch(`${app.baseUrl}/v1/projects`, {
    headers: { [SESSION_HEADER]: second.id },
  });
  expect(stillIn.status).toBe(200);
});

test('a session stops opening anything once it has expired', async () => {
  const clock = fakeTimeSource(new Date('2026-09-12T09:00:00.000Z'));
  const app = await startTestApi({ worker: false, timeSource: clock });
  started.push(app);

  // A session the sign-in route minted, so the life being aged past is the
  // one a deployment issues and not a fixture's.
  const signIn = await fetch(`${app.baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: TEST_USER.email,
      password: TEST_USER.password,
    }),
  });
  const { id } = (await signIn.json()) as { id: string };
  const present = () =>
    fetch(`${app.baseUrl}/v1/projects`, { headers: { [SESSION_HEADER]: id } });

  expect((await present()).status).toBe(200);

  // A year and a day. Aged by advancing the injected clock, never by
  // sleeping (ADR-0022) — which is only possible because the gate reads
  // expiry against that clock rather than the database's.
  clock.advance(366 * 24 * 60 * 60 * 1000);

  expect((await present()).status).toBe(401);
});

test("a disabled account's live sessions stop opening anything", async () => {
  const app = await startTestApi({ worker: false });
  started.push(app);

  const disabled = await app.fetch(`/v1/users/${app.user.id}/disable`, {
    method: 'POST',
  });
  expect(disabled.status).toBe(200);

  expect((await app.fetch('/v1/projects')).status).toBe(401);
});

test('a live session opens every route, and the gate leaves the answer alone', async () => {
  const app = await startTestApi({ worker: false });
  started.push(app);

  const response = await app.fetch('/v1/projects');

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([]);
});

test("the ingest webhook answers its own refusals rather than the gate's", async () => {
  const app = await startTestApi({ worker: false });
  started.push(app);

  // No session, and it still reaches the route: an address that names no
  // project is a 404 from `routes/ingest.ts`, not a 401 from the gate.
  const response = await fetch(`${app.baseUrl}/v1/ingest/inbound-mail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      to: 'nobody@ingest.test',
      from: 'stranger@example.com',
      subject: 'a message for no job',
      text: 'nothing here',
      files: [],
    }),
  });

  expect(response.status).toBe(404);
});
