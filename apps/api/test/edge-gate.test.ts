import { afterEach, expect, test } from 'vitest';
import { EDGE_SECRET_HEADER } from '../src/edge-gate.js';
import { startTestApi, TEST_EDGE_SECRET, type TestApi } from './harness.js';

const started: TestApi[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((instance) => instance.close()));
});

/**
 * The one route the gate lets through, named the way the hook names it
 * (ADR-0020). Inbound mail cannot present a cookie or a header: the provider
 * posts to an address, and the address's own unguessability and the rate
 * limit beneath it are what stand in the gate's place there (ADR-0042).
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

test('every route the API registers refuses a request carrying no secret, and the ingest webhook is the only one that does not', async () => {
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

test('the refusal says what is wrong and nothing about the record behind it', async () => {
  const app = await startTestApi({ worker: false });
  started.push(app);

  const response = await fetch(`${app.baseUrl}/v1/projects`);

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({
    message: 'This deployment is gated. Present the shared secret.',
  });
});

test('a wrong secret is refused exactly as no secret is', async () => {
  const app = await startTestApi({ worker: false });
  started.push(app);

  const response = await fetch(`${app.baseUrl}/v1/projects`, {
    headers: { [EDGE_SECRET_HEADER]: `${TEST_EDGE_SECRET}x` },
  });

  expect(response.status).toBe(401);
});

test('a secret that is a prefix of the real one is refused', async () => {
  const app = await startTestApi({ worker: false });
  started.push(app);

  const response = await fetch(`${app.baseUrl}/v1/projects`, {
    headers: { [EDGE_SECRET_HEADER]: TEST_EDGE_SECRET.slice(0, -1) },
  });

  expect(response.status).toBe(401);
});

test('the secret opens every route, and the gate leaves the answer alone', async () => {
  const app = await startTestApi({ worker: false });
  started.push(app);

  const response = await app.fetch('/v1/projects');

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([]);
});

test("the ingest webhook answers its own refusals rather than the gate's", async () => {
  const app = await startTestApi({ worker: false });
  started.push(app);

  // No secret, and it still reaches the route: an address that names no
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
