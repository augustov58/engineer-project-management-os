/**
 * What every record's routes stand on: the validation vocabulary their body
 * schemas share, the one way a Prisma error is read, and the dependencies a
 * route module is handed.
 *
 * A leaf on purpose. Nothing here imports a route module, which is what keeps
 * the read shapes two records share (`wire.ts`) from forming a cycle with the
 * records that return them.
 */

import type { Queue } from 'bullmq';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import type { ObjectStore } from './object-store.js';
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
}
