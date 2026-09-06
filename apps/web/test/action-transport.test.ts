import { afterEach, expect, test, vi } from 'vitest';
import { productSources } from './sources';

/**
 * A write whose request never gets an answer (issue: React #441 on storing a
 * document).
 *
 * Every *answer* the API can give was already handled — `refusal` turns a 400
 * or a 500 into the sentence the form prints. Never getting one was not: a
 * rejected `fetch` escaped the action, and React reports a rejected action to
 * the nearest error boundary as **Minified React error #441** plus a digest,
 * with the message omitted in production builds. So the one failure the
 * engineer most needs told about — nothing was written and the API is not
 * answering — was the one that reached them as an opaque page-level crash.
 *
 * The largest bodies in the product go through this path: a document version
 * is capped at 64 MiB of base64 (~48 MiB of file), and the deployed machine is
 * 1 GB shared between both halves and Chrome (ADR-0045), so an out-of-memory
 * kill on the far side is a real way to arrive here. It looks like any other
 * transport failure and must read like one.
 *
 * Source scans rather than renders, for `native-selects.test.tsx`'s reason:
 * the defect is in what the request does when it fails, and a screen renders
 * identically either way. `apps/web` has no runtime harness that can hold a
 * dead API open (ADR-0049 names what this suite does not cover).
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function actions(): string {
  const source = productSources().find(
    (candidate) => candidate.path === 'app/actions.ts',
  );
  expect(source).toBeDefined();
  return source!.text;
}

test('the one sender catches a request that never gets an answer', () => {
  const send = /\nasync function send\([\s\S]*?\n}/.exec(actions());
  expect(send).not.toBeNull();

  // Not a bare `return apiFetch(...)`: that settles the promise outside the
  // block and catches nothing, which is exactly how this got through.
  expect(send![0]).toContain('try {');
  expect(send![0]).toContain('return await apiFetch(');
  expect(send![0]).toContain('catch');
});

test('it answers with a Response, so no caller had to change', () => {
  // `refusal` reads `.status` and `.message`; `sendOrThrow` reads `.ok`. A
  // rethrow here would have put all 34 call sites back in the error boundary.
  const source = actions();
  const unreachable = /function unreachable\([\s\S]*?\n}/.exec(source);
  expect(unreachable).not.toBeNull();
  expect(unreachable![0]).toContain('503');
  expect(unreachable![0]).toContain('the API could not be reached');
  expect(unreachable![0]).toContain("'content-type': 'application/json'");
});

test('the message survives the round trip a form makes', async () => {
  // `refusal`'s own shape, exercised against exactly what `unreachable`
  // builds: a 503 carrying `message`. This is what the engineer reads instead
  // of React error #441.
  const built = new Response(
    JSON.stringify({ message: 'the API could not be reached — fetch failed' }),
    { status: 503, headers: { 'content-type': 'application/json' } },
  );

  expect(built.status).toBe(503);
  const body = (await built.json()) as { message?: string };
  expect(body.message).toBe('the API could not be reached — fetch failed');
  // Not the accepted status, so `refusal` returns the message rather than
  // undefined, and the form prints it in its `role="alert"`.
  expect(built.status).not.toBe(201);
});

test('no other module reaches the API, so this is the only door to fix', () => {
  // ADR-0020's guarantee, re-asserted here because this fix depends on it: if
  // a second `fetch` to the API existed, catching in `send` would leave it
  // crashing the same way.
  const offenders = productSources().filter(
    (source) =>
      source.path !== 'app/api.ts' &&
      /\bfetch\(\s*`?\$\{?apiUrl/.test(source.text),
  );
  expect(offenders.map((source) => source.path)).toEqual([]);
});
