/**
 * The two things both vendor adapters do the same way (issue #109).
 *
 * A leaf by ADR-0033's trigger and not before it: each of these was written
 * inside `ocr.ts` and moved here when `transcription.ts` reached for it, which
 * is the rule that put `stream.ts` where it is. It imports nothing from a route
 * module and nothing from either adapter, so neither can reach the other
 * through it.
 *
 * **Only what has two readers.** The poll helpers were briefly here too and
 * went back to `ocr.ts`, because the transcription adapter answers in one call
 * and never polls — one reader is not the trigger, and a leaf holding something
 * one caller uses is the Speculative Generality ADR-0033 exists to prevent. The
 * wall clock was never a candidate: a 2,000-page document and a ten-minute
 * recording are not the same kind of wait, and one shared number would be a
 * number chosen for neither, so each adapter names its own and says why.
 */

/** How much of a vendor's complaint is kept on the row a person reads. */
const COMPLAINT_LIMIT = 500;

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
