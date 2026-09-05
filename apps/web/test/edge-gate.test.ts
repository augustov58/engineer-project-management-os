import { expect, test } from 'vitest';
import { occurrences, productSources } from './sources';

/**
 * The door (ADR-0020), asserted from this side of it.
 *
 * `apps/api`'s `edge-gate.test.ts` sweeps every registered route and proves
 * that an anonymous caller is refused. It cannot prove the other half — that
 * every call this server makes carries the secret — because a call that was
 * never written is a call that suite never sees.
 *
 * That half was a rule about twenty-five call sites until issue #22, one was
 * missed, and the processing-location screen answered 401 with nothing in the
 * suite to catch it. `apiFetch` made it a rule about one function instead, and
 * these tests are what stops a second door being opened beside it. They are a
 * scan of the source rather than a render, because a second `fetch` paints
 * nothing: the defect is a call that exists, not a control that misbehaves.
 *
 * What this does **not** prove is that the secret the server sends is the one
 * the API accepts. Only the two processes running together answer that, and
 * ADR-0049 records it as the first of the four things this suite defers.
 */

/**
 * A bare `fetch(` call. `apiFetch(`, `.fetch(` and `refetch(` are deliberately
 * not matches: the rule is about opening a new connection to the API, and
 * going through the one function that does is the rule being kept.
 */
const bareFetch = /(?<![\w$.])fetch\s*\(/;

test('the only module that calls fetch is the one that attaches the secret', () => {
  const callers = productSources()
    .filter((source) => occurrences(source.text, bareFetch) > 0)
    .map((source) => source.path);

  expect(callers).toEqual(['app/api.ts']);
});

test('the secret is attached in exactly one place', () => {
  // `edge-secret.ts` defines `edgeHeaders`; `api.ts` calls it. A third file
  // naming it at all is a second call site for the header, which is the shape
  // ADR-0020 replaced.
  const naming = productSources()
    .filter((source) => source.text.includes('edgeHeaders'))
    .map((source) => source.path)
    .sort();

  expect(naming).toEqual(['app/api.ts', 'app/edge-secret.ts']);
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

test('the secret itself is read only by the module that holds it', () => {
  // `next.config.ts` refuses to boot without it (that is the whole of why it
  // is checked there), and `edge-secret.ts` reads it to present it. Anything
  // else reading `EDGE_SECRET` is a value on a path nobody audited — and a
  // `NEXT_PUBLIC_` spelling of it would be inlined into every client bundle.
  const reading = productSources()
    .filter((source) => source.text.includes("process.env['EDGE_SECRET']"))
    .map((source) => source.path)
    .sort();

  expect(reading).toEqual(['app/edge-secret.ts', 'next.config.ts']);

  const publicised = productSources().filter((source) =>
    source.text.includes('NEXT_PUBLIC_EDGE_SECRET'),
  );
  expect(publicised).toEqual([]);
});
