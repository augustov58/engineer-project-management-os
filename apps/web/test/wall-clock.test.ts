import { expect, test } from 'vitest';
import { clock, day, instantFrom } from '../app/wall-clock';
import { productSources } from './sources';

/**
 * The frame boundary, with only one side of it supplied here (ADR-0052's
 * fourth point, ADR-0054).
 *
 * Every other test in this product that touches time chooses both sides of
 * the comparison: it injects the clock **and** types the time, so the two can
 * never disagree inside it. Here the stamped side is a real instant and the
 * typed side is what the engineer would have read off the wall — and what the
 * wall said is ICU's answer, not this product's. `instantFrom` has to agree
 * with a timezone database it does not own, which is the property `#97`
 * falsified and the arithmetic alone cannot show.
 */

const NEW_YORK = 'America/New_York';

/** What the wall said, read from ICU rather than from anything under test. */
function wallClockIn(instant: Date, timeZone: string): [string, string] {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return [
    `${parts.year}-${parts.month}-${parts.day}`,
    `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`,
  ];
}

test.each([
  ['summer, four hours west', '2026-07-23T20:05:00.000Z'],
  ['winter, five hours west', '2026-01-23T21:05:00.000Z'],
  ['the first minute of a day there', '2026-07-23T04:00:00.000Z'],
  ['the last minute of a day there', '2026-07-24T03:59:00.000Z'],
])(
  'a time typed off the wall in %s composes back to the instant it was',
  (_name, iso) => {
    const stamped = new Date(iso);
    const [typedDay, typedTime] = wallClockIn(stamped, NEW_YORK);

    // The engineer types what the wall said; the record keeps the instant.
    expect(instantFrom(typedDay, typedTime, NEW_YORK)).toBe(iso);
  },
);

test('a typed time is not the UTC face of the instant it composes to', () => {
  // The whole of ADR-0050 was that these two were the same string. They are
  // not, and a test that did not say so would pass against either frame.
  expect(instantFrom('2026-07-23', '16:05', NEW_YORK)).toBe(
    '2026-07-23T20:05:00.000Z',
  );
  expect(instantFrom('2026-01-23', '16:05', NEW_YORK)).toBe(
    '2026-01-23T21:05:00.000Z',
  );
});

test('the hour that happens twice composes to the first of them', () => {
  // 01:30 on the morning the clocks go back is two real instants. The earlier
  // is the one the engineer was standing in when they wrote it down.
  expect(instantFrom('2026-11-01', '01:30', NEW_YORK)).toBe(
    '2026-11-01T05:30:00.000Z',
  );
});

test('the hour that never happens composes to a real instant', () => {
  // 02:30 on the morning the clocks go forward is no instant at all. Refusing
  // it would put a walk's schedule behind a validation error nobody can
  // satisfy, so it lands on the far side of the gap and stays an instant.
  const composed = instantFrom('2026-03-08', '02:30', NEW_YORK);
  expect(composed).toBe('2026-03-08T07:30:00.000Z');
  expect(new Date(composed).toISOString()).toBe(composed);
});

test('a typed time falls inside a window the server stamped', () => {
  // Issue #97 in one assertion, on the side of the boundary the composition
  // lives on. The window is two instants a *server clock* produced — the
  // blank-time floor path, which never went through any typed frame and is
  // what ADR-0050 failed to reason about. The photograph's time is what the
  // engineer read off the wall in the building's zone.
  //
  // This is the nearest an in-process suite gets to the frame boundary that
  // shipped #97: one side is a literal stamp and the other goes through the
  // production composition, so the assertion tells the two frames apart. The
  // real boundary is web→API and can only be crossed end to end, which
  // ADR-0052's fifth point refuses — named in ADR-0054 rather than pretended
  // away here.
  const started = Date.parse('2026-07-23T20:00:00.000Z'); // 16:00 in New York
  const completed = Date.parse('2026-07-23T20:45:00.000Z'); // 16:45 there

  const composed = Date.parse(instantFrom('2026-07-23', '16:05', NEW_YORK));
  // `binToFloor`'s predicate, both ends inclusive (ADR-0032).
  expect(started <= composed && composed <= completed).toBe(true);

  // And the frame that shipped #97: the same wall clock labelled `Z` is four
  // hours adrift of a window nobody typed, so every photograph on that floor
  // bound to nothing. This is the half that fails against the old composition.
  const asShipped = Date.parse('2026-07-23T16:05:00.000Z');
  expect(started <= asShipped && asShipped <= completed).toBe(false);
});

test('a day and a clock time are read back in the project’s zone', () => {
  const stamped = '2026-07-23T20:05:00.000Z';
  expect(day(stamped, NEW_YORK)).toBe('2026-07-23');
  expect(clock(stamped, NEW_YORK)).toBe('16:05');

  // Late enough in New York that the UTC face is already tomorrow: the day a
  // walk is filed under is the building's, not Greenwich's.
  expect(day('2026-07-24T03:30:00.000Z', NEW_YORK)).toBe('2026-07-23');
  expect(clock('2026-07-24T03:30:00.000Z', NEW_YORK)).toBe('23:30');
});

test('one file composes an instant, and it is the one that knows the zone', () => {
  // `asTypedInstant` and `composeInstant` were one frame on purpose and went
  // together, as ADR-0050 required of whatever superseded it (ADR-0054). The
  // shape rather than the name: a typed time labelled `Z` in a template is the
  // old frame, and `instantFrom` is the only place it may still be written —
  // there it is a coordinate being converted, not a value being sent.
  const labelled = productSources().filter((source) =>
    /\$\{[^}]*\}(?:T[^`]*)?:00\.000Z/.test(source.text),
  );
  expect(labelled.map((source) => source.path)).toEqual(['app/wall-clock.ts']);
});
