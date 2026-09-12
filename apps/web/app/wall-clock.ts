/**
 * The project's zone, which is the one frame this product reads and writes in.
 *
 * Every stored `DateTime` is a real instant (ADR-0054). A typed day and clock
 * time are composed into one here, in the zone of the building the job is at,
 * and an instant is read back into that zone here too — so the screen, the
 * report and anything the injected `TimeSource` stamped are finally one frame.
 *
 * This **supersedes `asTypedInstant`**, which wrote the browser's local wall
 * clock as though it were UTC so that a photograph would bin against a typed
 * floor window. ADR-0050 coupled that helper to `composeInstant` and required
 * the two to change in one commit; they did, and one of them is gone. What
 * made 0050 false is that a floor window started by the blank-time path is
 * stamped, so `binToFloor` was comparing a real instant against fake ones and
 * every photograph on that floor bound to nothing, silently (issue #97).
 *
 * The zone is the project's and never the browser's. A walk happens where the
 * building is; an engineer reading the record from another zone is reading
 * about that building's afternoon, not their own.
 */

const DAY = 24 * 60 * 60 * 1000;

/** The fields of an instant as a zone renders them. */
function partsIn(
  instant: Date,
  timeZone: string,
): { year: string; month: string; day: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);

  const read = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '00';

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // `hourCycle` h23 is what `hour12: false` asks for, and ICU answers '24'
    // for midnight in some locales. Midnight is hour zero.
    hour: read('hour') === '24' ? '00' : read('hour'),
    minute: read('minute'),
  };
}

/**
 * How far ahead of UTC the zone was at a given instant, in milliseconds.
 *
 * Read out of ICU rather than tabulated: a timezone database is a thing this
 * product uses and never owns (ADR-0041's rule, arriving for a second vendor).
 */
function offsetAt(utcMilliseconds: number, timeZone: string): number {
  const at = partsIn(new Date(utcMilliseconds), timeZone);
  const asIfUtc = Date.UTC(
    Number(at.year),
    Number(at.month) - 1,
    Number(at.day),
    Number(at.hour),
    Number(at.minute),
  );
  // The instant is at whole minutes in both readings, so the seconds and
  // milliseconds of the original do not enter the difference.
  return asIfUtc - Math.floor(utcMilliseconds / 60_000) * 60_000;
}

/**
 * The instant a typed day and clock time name in a zone — `2026-07-23`,
 * `16:05` and `America/New_York` are `2026-07-23T20:05:00.000Z`.
 *
 * Twice a year a wall clock is not a function of the instant. The hour that
 * **happens twice** composes to the first of the two, which is the one the
 * engineer was standing in when they wrote it down; the hour that **never
 * happens** composes to the far side of the gap, so a midnight that a zone
 * skips lands on the right day rather than an hour into the previous one.
 * Both fall out of reading the offset from *before* the wall time and keeping
 * that answer when neither offset fits — the rule a timezone-aware runtime
 * calls *compatible*, spelled out because this product has no such runtime.
 */
export function instantFrom(day: string, time: string, timeZone: string): string {
  // The wall clock read as though it were UTC: not an instant, a coordinate.
  const wall = Date.parse(`${day}T${time}:00.000Z`);

  const before = offsetAt(wall - DAY, timeZone);
  const composed = wall - before;
  if (offsetAt(composed, timeZone) === before) {
    return new Date(composed).toISOString();
  }

  const after = offsetAt(wall + DAY, timeZone);
  const alternative = wall - after;
  return new Date(
    offsetAt(alternative, timeZone) === after ? alternative : composed,
  ).toISOString();
}

/** Just the day: the record keeps an instant, the screen does not need one. */
export function day(instant: string, timeZone: string): string {
  const at = partsIn(new Date(instant), timeZone);
  return `${at.year}-${at.month}-${at.day}`;
}

/** The clock time of an instant, which is how a schedule is read. */
export function clock(instant: string, timeZone: string): string {
  const at = partsIn(new Date(instant), timeZone);
  return `${at.hour}:${at.minute}`;
}
