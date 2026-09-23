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
    // The one field this read carries that `userOnTheWire` does not: the
    // theme is the signed-in person's own and is read by the layout that
    // writes the class, so it rides the read that layout already makes
    // (issue #117).
    theme: 'SYSTEM',
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

/**
 * The throttle in front of sign-in (issue #125, ADR-0062).
 *
 * `test/gate.test.ts` owns what the boundary does with a session and the two
 * tests above own the one refusal; these own the limit that now sits in front
 * of both. Every one of them ages a fake clock rather than sleeping (ADR-0022),
 * which is only possible because the limit is counted against the injected
 * `TimeSource` and not the database's.
 */

/** A failed attempt at one address, optionally reporting where it came from. */
function wrongPassword(app: TestApi, email: string, source?: string) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (source !== undefined) {
    headers['x-sign-in-source'] = source;
  }
  return fetch(`${app.baseUrl}/v1/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password: 'not-the-password' }),
  });
}

/**
 * The rows, read through `GET /v1/export` and not off the database.
 *
 * Fixtures and readings both go through the API in this suite — `tableNames()`
 * is the one sanctioned way past that boundary and it returns names only — and
 * here the export is the *only* reader this record has, so asserting through it
 * is asserting the thing the product actually offers (ADR-0062 decision 9).
 */
async function recorded(app: TestApi) {
  const response = await app.fetch('/v1/export');
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    records: Record<string, Record<string, unknown>[]>;
  };
  return (body.records['signInFailures'] ?? [])
    .map(({ id: _id, ...rest }) => rest)
    // By code unit and not `localeCompare`, which collates differently
    // depending on where the suite runs. `'S' < 'a'` here, so the capitalised
    // address sorts first.
    .sort((a, b) => (String(a['email']) < String(b['email']) ? -1 : 1));
}

async function failures(app: TestApi) {
  return (await recorded(app)).length;
}

/** The one refusal, which a throttled caller gets too (ADR-0062 decision 5). */
async function isTheOneRefusal(response: Response) {
  const body = (await response.json()) as { message?: string };
  return (
    response.status === 401 &&
    body.message === 'That is not an account here, or not its password.'
  );
}

test('ten failures against one address is where the address stops being tried', async () => {
  const clock = fakeTimeSource(new Date('2026-09-22T09:00:00.000Z'));
  const app = await api({ timeSource: clock });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    expect(await isTheOneRefusal(await wrongPassword(app, TEST_USER.email))).toBe(true);
  }

  // The eleventh is refused by the count rather than by the password, and the
  // engineer's own correct password is refused with it: this is a throttle on
  // the address and not a check that happens to fail.
  expect(await isTheOneRefusal(await wrongPassword(app, TEST_USER.email))).toBe(true);
  const correct = await signIn(app, {
    email: TEST_USER.email,
    password: TEST_USER.password,
  });
  expect(correct.status).toBe(401);

  // Ten rows and not twelve: an attempt refused by the throttle writes none
  // (ADR-0062 decision 6), which is what keeps the window rolling.
  expect(await failures(app)).toBe(10);
});

test('the window rolls, so a throttled address is tried again a quarter-hour later', async () => {
  const clock = fakeTimeSource(new Date('2026-09-22T09:00:00.000Z'));
  const app = await api({ timeSource: clock });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await wrongPassword(app, TEST_USER.email);
  }
  expect(
    (await signIn(app, { email: TEST_USER.email, password: TEST_USER.password }))
      .status,
  ).toBe(401);

  // Aged by advancing the injected clock, never by sleeping (ADR-0022).
  clock.advance(15 * 60 * 1000 + 1);

  const after = await signIn(app, {
    email: TEST_USER.email,
    password: TEST_USER.password,
  });
  expect(after.status).toBe(201);
});

test('an engineer who mistypes twice on a phone is nowhere near the limit', async () => {
  const clock = fakeTimeSource(new Date('2026-09-22T09:00:00.000Z'));
  const app = await api({ timeSource: clock });

  // ADR-0055: field capture is a phone inside a building and nothing may stand
  // between the engineer and a walk. Two fat-fingered attempts and the third
  // is the real one, in the same instant.
  await wrongPassword(app, TEST_USER.email);
  await wrongPassword(app, TEST_USER.email);

  const third = await signIn(app, {
    email: TEST_USER.email,
    password: TEST_USER.password,
  });
  expect(third.status).toBe(201);
});

test('the limit is per address, so one address under attack does not close another', async () => {
  const clock = fakeTimeSource(new Date('2026-09-22T09:00:00.000Z'));
  const app = await api({ timeSource: clock });

  // An address with no account behind it is counted exactly as one with an
  // account is: writing a row only for a known address would restore the
  // asymmetry `unmatchableHash` exists to remove.
  for (let attempt = 0; attempt < 11; attempt += 1) {
    await wrongPassword(app, 'stranger@example.test');
  }

  const engineer = await signIn(app, {
    email: TEST_USER.email,
    password: TEST_USER.password,
  });
  expect(engineer.status).toBe(201);
});

test('thirty failures from one source stops that source, whatever address it tries', async () => {
  const clock = fakeTimeSource(new Date('2026-09-22T09:00:00.000Z'));
  const app = await api({ timeSource: clock });

  // Three addresses, ten each: under the per-address limit every time, and at
  // the per-source limit once. Sprayed this way, the address count never fires.
  for (const guess of ['one@example.test', 'two@example.test', 'three@example.test']) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(await isTheOneRefusal(await wrongPassword(app, guess, '203.0.113.7'))).toBe(true);
    }
  }
  expect(await failures(app)).toBe(30);

  // A fourth address from the same place is refused without being counted.
  expect(
    await isTheOneRefusal(await wrongPassword(app, 'four@example.test', '203.0.113.7')),
  ).toBe(true);
  expect(await failures(app)).toBe(30);

  // Somewhere else is unaffected, and so is the engineer with no source at all.
  expect(
    (await wrongPassword(app, 'four@example.test', '198.51.100.9')).status,
  ).toBe(401);
  expect(await failures(app)).toBe(31);
  const engineer = await signIn(app, {
    email: TEST_USER.email,
    password: TEST_USER.password,
  });
  expect(engineer.status).toBe(201);
});

test('a stranger cannot hold an engineer out of a walk by guessing at their address', async () => {
  const clock = fakeTimeSource(new Date('2026-09-22T09:00:00.000Z'));
  const app = await api({ timeSource: clock });

  // Somebody who knows the address, guessing from their own machine until the
  // address's count is spent.
  for (let attempt = 0; attempt < 11; attempt += 1) {
    expect(
      await isTheOneRefusal(await wrongPassword(app, TEST_USER.email, '198.51.100.9')),
    ).toBe(true);
  }

  // The engineer's phone, somewhere else, with the right password. This is the
  // whole of ADR-0055's "nothing stands between the engineer and a walk": the
  // count is spent for that address *from that source*, and a stranger has no
  // way to reach into somebody else's. Without the source on the count this
  // answers 401, which is a stranger doing what only ADR-0055 part 5's route
  // may do.
  const phone = await fetch(`${app.baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sign-in-source': '203.0.113.7',
    },
    body: JSON.stringify({
      email: TEST_USER.email,
      password: TEST_USER.password,
    }),
  });
  expect(phone.status).toBe(201);

  // And the stranger is still spent, so the bound they were refused by holds.
  expect(
    await isTheOneRefusal(await wrongPassword(app, TEST_USER.email, '198.51.100.9')),
  ).toBe(true);
});

test('a body that is not credentials is refused and recorded nowhere', async () => {
  const app = await api();

  // There is no address to file these under, and the sweep in gate.test.ts
  // makes one of them against every route.
  await signIn(app, { email: TEST_USER.email });
  await signIn(app, 'a string, which is not credentials');
  await fetch(`${app.baseUrl}/v1/sessions`, { method: 'POST' });
  // Longer than any address can be (RFC 5321), which is the only bound on a
  // route with no body schema.
  await signIn(app, { email: `${'a'.repeat(255)}@example.test`, password: 'x' });

  expect(await failures(app)).toBe(0);
});

test('a failed sign-in records the address and the source and no password', async () => {
  const clock = fakeTimeSource(new Date('2026-09-22T09:00:00.000Z'));
  const app = await api({ timeSource: clock });

  await wrongPassword(app, 'Stranger@Example.test', '203.0.113.7');
  await wrongPassword(app, TEST_USER.email);

  // Sorted by address by the reader above, so this asserts the rows and not
  // the uuid order the export happens to return them in.
  const rows = await recorded(app);
  expect(rows).toEqual([
    // Not normalised: only the exact spelling can ever sign in, so only the
    // exact spelling is worth bounding.
    {
      email: 'Stranger@Example.test',
      source: '203.0.113.7',
      attemptedAt: '2026-09-22T09:00:00.000Z',
    },
    {
      email: TEST_USER.email,
      source: null,
      attemptedAt: '2026-09-22T09:00:00.000Z',
    },
  ]);
});

test('signing in successfully records nothing', async () => {
  const app = await api();

  expect(
    (await signIn(app, { email: TEST_USER.email, password: TEST_USER.password }))
      .status,
  ).toBe(201);

  expect(await failures(app)).toBe(0);
});
