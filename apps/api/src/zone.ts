/**
 * Reading an instant back in a project's zone (ADR-0054).
 *
 * Every stored `DateTime` is a real instant and `projects.timezone` is the one
 * column that says how to read one. Two things here need to: the date a walk
 * is filed under, which is the day its start falls on where the building is
 * (ADR-0030), and the report, which prints both a day and a clock time.
 *
 * A **leaf** for ADR-0033's reason — `wire.ts` and `report.ts` both reach for
 * it, and a thing two records use is what moves out of the record that had it
 * first. It imports nothing of this product's.
 *
 * There is no composition here, only reading: the API never composes a typed
 * day and time. It takes the instant it is given or stamps the injected
 * `TimeSource` (ADR-0022), and `instant()` did not change when this arrived.
 * Composing is `apps/web`'s `instantFrom`, and it is the only half of the
 * arithmetic that has a daylight-saving edge to get wrong.
 */

/** The fields of an instant as a zone renders them. */
function partsIn(instant: Date, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

/** The day an instant falls on there, as `YYYY-MM-DD`. */
export function dayIn(instant: Date, timeZone: string): string {
  const at = partsIn(instant, timeZone);
  return `${at.year}-${at.month}-${at.day}`;
}

/** The clock time an instant reads there, as `HH:MM`. */
export function clockIn(instant: Date, timeZone: string): string {
  const at = partsIn(instant, timeZone);
  // `hour12: false` asks for the h23 cycle and ICU answers '24' for midnight
  // in some locales. Midnight is hour zero.
  return `${at.hour === '24' ? '00' : at.hour}:${at.minute}`;
}

/**
 * Both, the way a person reads one — `2026-07-23 13:00`.
 *
 * The face an audit line's prose carries where the value it quotes was typed
 * as a day *and* a clock time (issue #123, ADR-0054 decision 3 as amended); a
 * value typed as a day alone takes `dayIn` and gets no clock, because the
 * `00:00` would be one the engineer never entered. It is here rather than
 * spelled into each route that writes such a line, which is ADR-0033's
 * trigger reached the moment the second one did; how many there are is
 * written down in `.claude/rules/memory.md` and deliberately not here. The
 * order and the separator are the activity feed's own column's, so the two
 * halves of a row cannot print one instant two ways.
 */
export function readIn(instant: Date, timeZone: string): string {
  return `${dayIn(instant, timeZone)} ${clockIn(instant, timeZone)}`;
}
