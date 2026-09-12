/**
 * How a password is stored and how one is checked (issue #105, ADR-0055).
 *
 * A **leaf** in ADR-0033's sense: it imports a hashing library and nothing
 * from a route module. It was a leaf from its first line rather than after a
 * move, for `zone.ts`'s reason — three callers reached for it at once: the
 * sign-in route, the create-a-user route, and the machine command behind both.
 *
 * **argon2id**, named by ADR-0055 and not chosen here. The encoded form the
 * library returns carries its own parameters, so raising them later leaves
 * every existing hash verifiable and a re-hash is a sign-in away rather than a
 * migration.
 *
 * The verifier is given a hash that may be wrong-shaped — a row edited by
 * hand, a parameter set the build no longer supports — and answers `false`
 * rather than throwing, so a damaged row refuses a sign-in instead of 500ing
 * it. There is nothing a caller could do differently with the distinction.
 */

import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/**
 * A password's minimum length, and the only rule there is.
 *
 * Not a composition rule: a class requirement rules out more good passwords
 * than bad ones, and this deployment has no password reset that does not go
 * through the author at a laptop (ADR-0055 part 7) — so the cost of a
 * forgotten one is real and the rule that would cause one is not taken.
 */
export const MINIMUM_PASSWORD_LENGTH = 12;

export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function passwordMatches(
  encoded: string,
  presented: string,
): Promise<boolean> {
  try {
    return await verify(encoded, presented);
  } catch {
    return false;
  }
}

/**
 * A real hash of a value nobody holds, for verifying against when no account
 * matches the address presented.
 *
 * Without it, signing in as an unknown address returns in the time of one
 * database lookup and signing in as a known one with the wrong password in the
 * time of an argon2id verification — tens of milliseconds apart, which is a
 * readable answer to "does this person have an account here". Verifying
 * against this instead costs the same work, so the two are the same refusal
 * all the way down.
 *
 * Built on first use rather than at module load, so that importing this file
 * costs nothing and no top-level await propagates to every importer; kept
 * afterwards, so the cost is paid once per process.
 */
let unmatchable: Promise<string> | null = null;

export function unmatchableHash(): Promise<string> {
  unmatchable ??= hashPassword(randomBytes(32).toString('hex'));
  return unmatchable;
}
