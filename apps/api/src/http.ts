/**
 * What every record's routes stand on: the validation vocabulary their body
 * schemas share, the one way a Prisma error is read, and the dependencies a
 * route module is handed.
 *
 * A leaf on purpose: nothing here imports a route module, so every record can
 * reach it without reaching through another record. `refusals.ts` and
 * `wire.ts` are leaves for the same reason and each for its own sake.
 */

import type { Queue } from 'bullmq';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import type { ObjectStore } from './object-store.js';
import type { InboundMailProvider } from './inbound-mail.js';
import type { TimeSource } from './time-source.js';

const UNIQUE_VIOLATION = 'P2002';

export function isUniqueViolation(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === UNIQUE_VIOLATION
  );
}

/**
 * A unique violation, and specifically the one on the named column.
 * `writeIssuance` also writes join rows with a composite key of their own, so
 * an unqualified check would answer "that submission has already been
 * superseded" to a collision that had nothing to do with superseding — a
 * message that would be a lie at the one moment anybody read it.
 *
 * Matched against the whole of `meta` rather than a path into it. The pg
 * driver adapter reports the column under
 * `meta.driverAdapterError.cause.constraint.fields` and leaves `meta.target`
 * — the documented place — undefined, so reading the documented path would
 * quietly answer "not this constraint" to every violation and turn the race
 * this guards into a 500. Verified against a real P2002 from this schema.
 */
export function violates(error: unknown, column: string): boolean {
  if (!isUniqueViolation(error)) {
    return false;
  }
  return JSON.stringify(error.meta ?? {}).includes(column);
}

/**
 * At least one character that is not whitespace. `minLength: 1` would accept
 * "   ", which stores as a filled-in field and reads as an empty one — and for
 * `waitingOn` would be indistinguishable on screen from nobody.
 */
export const NOT_BLANK = '\\S';

/** The alphabet and the padding position, which is all a pattern can hold. */
const BASE64_ALPHABET = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Base64 carrying a file: the alphabet, the padding, **and whole quartets**.
 *
 * A predicate and not a pattern, which is forced rather than chosen. The four
 * large-body routes spelled the quartet rule as
 * `^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$`, and a
 * starred *group* recurses once per iteration in V8: above roughly four
 * million characters — a 3 MiB file, an ordinary phone photograph — it threw
 * `RangeError: Maximum call stack size exceeded`. Nothing sets an error
 * handler here, so that reached the engineer as a 500 carrying V8's own
 * sentence, and every declared cap was several times what the boundary could
 * survive (issue #98). A starred *character class* does not recurse, and is
 * measured flat to 64 MiB.
 *
 * The guarantee is unchanged, and that is the point of splitting it in two
 * rather than loosening it: `[A-Za-z0-9+/]+={0,2}` alone admits a length of
 * 4n+1, which is not base64 at all and which `Buffer.from` **silently
 * truncates** rather than refusing — a short file stored under a 201, with
 * nothing downstream able to read it back against the original (ADR-0039).
 * The length check is what keeps that refusal, and it is arithmetic rather
 * than backtracking. The two together accept and refuse exactly what the old
 * pattern did, save for the empty string, which every schema using this
 * already refuses with `minLength: 4`.
 *
 * Registered as the ajv format `base64` in `server.ts` — the boundary, where
 * the ajv setting belongs (ADR-0033) — so a body still fails validation the
 * way it always did, and read directly by `routes/ingest.ts`, whose files are
 * checked one at a time rather than by a schema.
 */
export function isBase64(value: string): boolean {
  return value.length % 4 === 0 && BASE64_ALPHABET.test(value);
}

/**
 * The bytes of a file on the way in, less the cap, which is each record's own.
 *
 * Four characters of base64 is one byte or more, so a body that passes this
 * can never decode to the nothing the CHECK constraints refuse.
 */
export const BASE64 = {
  type: 'string',
  format: 'base64',
  minLength: 4,
} as const;

/**
 * A supplied instant, or the injected time source. Parsing a string the
 * engineer typed is not reading the wall clock, so ADR-0022 is satisfied by
 * the fallback being `timeSource.now()` and never `new Date()`.
 */
export function instant(
  supplied: string | undefined,
  timeSource: TimeSource,
): Date {
  return supplied === undefined ? timeSource.now() : new Date(supplied);
}

/**
 * The floor designation, without the word "Floor" — "3", "B1", "M", "PH".
 *
 * Free text and not an integer: the grammar writes `Floor N`, but a building
 * with a basement, a mezzanine or a penthouse has floors that are not numbers,
 * and an integer column could not record an observation made in any of them
 * (ADR-0030). Capped at the revision's 32, being the other short designation.
 */
export const FLOOR = {
  type: 'string',
  pattern: NOT_BLANK,
  maxLength: 32,
} as const;

/**
 * What a route module is handed.
 *
 * The four `buildServer` resolves, with the clock no longer optional: the
 * default belongs at the boundary (ADR-0022), and a route reading `timeSource`
 * should never have to ask whether it is there.
 */
export interface RouteDependencies {
  prisma: PrismaClient;
  queue: Queue;
  objectStore: ObjectStore;
  timeSource: TimeSource;
  /** How a webhook payload is read. No adapter is written (ADR-0042). */
  inboundMail: InboundMailProvider;
  /** The half of an ingest address that is not secret. Null when unset. */
  ingestDomain: string | null;
}
