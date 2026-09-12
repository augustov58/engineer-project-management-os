/**
 * The gate on this side of it (issue #105, ADR-0055), and the one guard in
 * front of it.
 *
 * `apps/api`'s `gate.test.ts` sweeps every route and proves a caller with no
 * session is refused there. Neither suite covered **this** file until now:
 * `proxy.ts` decided who got past the Next server, and `destination()` decided
 * where a signed-in engineer landed, and a regression in either was invisible
 * to `pnpm test`. That was true before this ticket and would have been true
 * after it, with both functions rewritten — which is why it is closed here.
 *
 * `proxy()` is a plain function over a `NextRequest`, so this needs no
 * infrastructure the suite does not already have (ADR-0049's level, unchanged).
 * What it still does **not** prove is that Next actually runs this file for the
 * paths the matcher names; that is the framework's half, and ADR-0049 records
 * end-to-end as deferred under a named trigger.
 */

import { NextRequest } from 'next/server';
import { expect, test } from 'vitest';
import { destination } from '../app/sign-in/destination';
import { config, proxy } from '../proxy';

const PAGE = { accept: 'text/html,application/xhtml+xml' };

function request(
  path: string,
  { method = 'GET', headers = {}, session }: {
    method?: string;
    headers?: Record<string, string>;
    session?: string;
  } = {},
) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: {
      ...headers,
      ...(session === undefined ? {} : { cookie: `session=${session}` }),
    },
  });
}

test('a page asked for without a session is sent to sign in, and told where to come back to', () => {
  const response = proxy(request('/projects/abc?tab=memory', { headers: PAGE }));

  expect(response.status).toBe(307);
  expect(response.headers.get('location')).toBe(
    'http://localhost:3000/sign-in?next=%2Fprojects%2Fabc%3Ftab%3Dmemory',
  );
});

test('everything that is not a page navigation is refused where it stands', async () => {
  // An `EventSource` follows a redirect, would parse the sign-in page as a
  // stream, fail, and reconnect forever without ever showing anybody an
  // error. So would a server action, whose reply is not a document either.
  for (const asked of [
    request('/projects/abc/memory/stream', { headers: { accept: 'text/event-stream' } }),
    request('/projects/abc', { method: 'POST', headers: PAGE }),
    request('/export'),
  ]) {
    const response = proxy(asked);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message: 'Not signed in.' });
  }
});

test('the sign-in screen is exempted inside the function, and its own action with it', () => {
  // Never in the matcher: a path a matcher skips is a path this file never
  // sees, and a server action is a POST to the route it is used on — so an
  // exclusion would silently un-gate the sign-in action too.
  expect(proxy(request('/sign-in', { headers: PAGE })).status).toBe(200);
  expect(proxy(request('/sign-in', { method: 'POST' })).status).toBe(200);

  expect(config.matcher).toEqual(['/((?!_next/static|_next/image|favicon.ico).*)']);
  for (const pattern of config.matcher) {
    expect(pattern).not.toContain('sign-in');
  }
});

test('a session gets through, and an empty cookie is no session at all', () => {
  expect(proxy(request('/pending', { headers: PAGE, session: 'aWtT9' })).status).toBe(200);

  // A browser handed `session=` would otherwise get past here and be refused
  // by the API one round trip later — a redirect the engineer sees for no
  // reason.
  expect(proxy(request('/pending', { headers: PAGE, session: '' })).status).toBe(307);
});

test('the sign-in screen cannot be turned into a redirector to anywhere', () => {
  // The guard that arrived as a review finding on issue #22, and the reason it
  // resolves rather than inspecting the first characters: a browser reads both
  // of the first two as another origin, the second because `URL` normalises a
  // backslash to a slash, so a prefix test has to know every spelling.
  for (const hostile of [
    '//elsewhere.example',
    '/\\elsewhere.example',
    'https://elsewhere.example/',
    'elsewhere.example',
    '',
  ]) {
    expect(destination(hostile)).toBe('/');
  }

  expect(destination(null)).toBe('/');
  expect(destination('/pending?owner=Nobody')).toBe('/pending?owner=Nobody');
  expect(destination('/site-visits/abc#floor-3')).toBe('/site-visits/abc');
});
