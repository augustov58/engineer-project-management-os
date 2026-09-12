import { expect, test } from 'vitest';
import { occurrences, productSources } from './sources';

/**
 * The door (ADR-0055), asserted from this side of it.
 *
 * `apps/api`'s `gate.test.ts` sweeps every registered route and proves that a
 * caller carrying no session is refused. It cannot prove the other half — that
 * every call this server makes carries one — because a call that was never
 * written is a call that suite never sees.
 *
 * That half was a rule about twenty-five call sites until issue #22, one was
 * missed, and the processing-location screen answered 401 with nothing in the
 * suite to catch it. `apiFetch` made it a rule about one function instead, and
 * these tests are what stops a second door being opened beside it. They are a
 * scan of the source rather than a render, because a second `fetch` paints
 * nothing: the defect is a call that exists, not a control that misbehaves.
 *
 * What this does **not** prove is that the session the server sends is one the
 * API accepts. Only the two processes running together answer that, and
 * ADR-0049 records it as the first of the four things this suite defers.
 */

/**
 * A bare `fetch(` call. `apiFetch(`, `.fetch(` and `refetch(` are deliberately
 * not matches: the rule is about opening a new connection to the API, and
 * going through the one function that does is the rule being kept.
 */
const bareFetch = /(?<![\w$.])fetch\s*\(/;

test('the only module that calls fetch is the one that attaches the session', () => {
  const callers = productSources()
    .filter((source) => occurrences(source.text, bareFetch) > 0)
    .map((source) => source.path);

  expect(callers).toEqual(['app/api.ts']);
});

test('the session is attached in exactly one place', () => {
  // `session.ts` names the header; `api.ts` sets it. A third file naming it at
  // all is a second call site for the credential, which is the shape ADR-0020
  // replaced and ADR-0055 kept replaced.
  const naming = productSources()
    .filter((source) => source.text.includes('SESSION_HEADER'))
    .map((source) => source.path)
    .sort();

  expect(naming).toEqual(['app/api.ts', 'app/session.ts']);
});

test('the cookie is reached for in three places, and none of them is a screen', () => {
  // `session.ts` names it; `proxy.ts` reads it in front of every request;
  // `api.ts` reads it to forward it; the sign-in action writes it and the
  // sign-out action clears it. A screen that reached for the cookie would be a
  // screen holding a credential, and it would show up here.
  const naming = productSources()
    .filter((source) => source.text.includes('SESSION_COOKIE'))
    .map((source) => source.path)
    .sort();

  expect(naming).toEqual([
    'app/api.ts',
    'app/session.ts',
    'app/sign-in/actions.ts',
    'proxy.ts',
  ]);
});

test('the API origin is read in exactly one place', () => {
  // The door needs somewhere to open onto. A second module reading the origin
  // is the first half of a second door, and it is visible here before the
  // `fetch` beside it is written.
  const reading = productSources()
    .filter((source) => source.text.includes("process.env['NEXT_PUBLIC_API_URL']"))
    .map((source) => source.path);

  expect(reading).toEqual(['app/api.ts']);
});

test('no credential is configured into this app at all, and none is publicised', () => {
  // The shared secret is gone (ADR-0055): there is no `EDGE_SECRET` to read,
  // no `/unlock` to present it at, and nothing for a `NEXT_PUBLIC_` spelling
  // to inline into every client bundle. The session id is minted by the API
  // and arrives in a cookie, so this app is configured with an origin and
  // nothing else.
  const sources = productSources();
  expect(sources.filter((s) => s.text.includes('EDGE_SECRET'))).toEqual([]);
  expect(sources.filter((s) => s.text.includes('UNLOCK_PATH'))).toEqual([]);

  const configured = sources.flatMap((source) => [
    ...source.text.matchAll(/NEXT_PUBLIC_[A-Z_]+/g),
  ]);
  expect([...new Set(configured.map((match) => match[0]))]).toEqual([
    'NEXT_PUBLIC_API_URL',
  ]);
});
