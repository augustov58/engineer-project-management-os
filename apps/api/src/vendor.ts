/**
 * The four things both vendor adapters do the same way (issue #109).
 *
 * A leaf by ADR-0033's trigger and not before it: each of these was written
 * inside `ocr.ts` and moved here the moment `transcription.ts` reached for it,
 * which is the rule that put `stream.ts` where it is. It imports nothing from
 * a route module and nothing from either adapter, so neither can reach the
 * other through it.
 *
 * What is deliberately *not* here is the wall clock or the poll floor. A
 * document of 2,000 pages and a ten-minute recording are not the same kind of
 * wait, and a single shared number would be a number chosen for neither; each
 * adapter names its own and says why.
 */

/** How much of a vendor's complaint is kept on the row a person reads. */
const COMPLAINT_LIMIT = 500;

/** A `Retry-After` is honoured, but never past this — the bound is ours. */
const MAX_POLL_MS = 30_000;

/**
 * What a vendor said when it refused, bounded, for the row it will be read on.
 *
 * Bounded rather than truncated silently in the sense ADR-0039 forbids: this
 * is not a record of something a person wrote, it is a diagnostic, and an
 * unbounded one would put a vendor's entire error document into `failure` and
 * onto a screen. Never allowed to throw — a body that will not read is itself
 * only worth a sentence, and losing the status code to a decoding error would
 * be losing the useful half.
 */
export async function complaint(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, COMPLAINT_LIMIT);
  } catch {
    return '(the vendor sent nothing readable)';
  }
}

/**
 * Whether a rejection is the wall clock rather than the vendor.
 *
 * Two names, because `AbortSignal.timeout` aborts with a `TimeoutError` and a
 * cancelled request aborts with an `AbortError`, and both arrive here as the
 * reason a `fetch` rejected.
 */
export function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

/**
 * How long to wait before asking again: the vendor's opinion where it has one,
 * ours where it does not, and never longer than `MAX_POLL_MS`.
 *
 * Clamped because `Retry-After` is a value the far side chooses, and an hour
 * of it would hold a worker slot for an hour inside a wall clock that was
 * supposed to bound exactly that.
 */
export function waitFor(response: Response, floorMs: number): number {
  const after = Number(response.headers.get('retry-after'));
  return Number.isFinite(after) && after > 0
    ? Math.min(after * 1000, MAX_POLL_MS)
    : floorMs;
}

/**
 * Wait, and stop waiting early if the wall clock runs out.
 *
 * Not `setTimeout` alone: a poll floor of thirty seconds inside a bound that
 * has already expired is thirty seconds of a worker doing nothing before it
 * reads the signal that was set before it started sleeping.
 */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
