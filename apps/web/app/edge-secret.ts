/**
 * The one shared secret in front of every route (ADR-0020), on this side of
 * it.
 *
 * The engineer presents it once at `/unlock` and the browser holds it in a
 * cookie, which `proxy.ts` checks in front of every page, every server action
 * and every proxy route. The Next server presents the same value to the API
 * as a header, because no browser reaches the API — every call is made here.
 *
 * The variable is deliberately **not** `NEXT_PUBLIC_`: that prefix is what
 * makes a value available to the browser, and it does that by inlining it
 * into every client bundle. It is read inside a function rather than at
 * module scope for the same care: nothing about this module is evaluated
 * where it should not be.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** Where the browser holds it. */
export const EDGE_COOKIE = 'edge_secret';

/** What the API reads it from, the same name `apps/api` writes down. */
export const EDGE_SECRET_HEADER = 'x-edge-secret';

/** Where the engineer is sent to present it, and the one path the gate lets by. */
export const UNLOCK_PATH = '/unlock';

export function edgeSecret(): string {
  const secret = process.env['EDGE_SECRET'];
  if (secret === undefined || secret === '') {
    // Unreachable in a running deployment: `next.config.ts` refuses to boot
    // without it. Here so that a mistake is a refusal and never an open door.
    throw new Error('EDGE_SECRET is not set');
  }
  return secret;
}

/**
 * Whether a presented value is the secret, in time that does not depend on
 * how much of it is right. Both are digested first, so `timingSafeEqual` has
 * two equal lengths to compare and the length of a guess leaks nothing.
 */
export function unlocked(presented: string | undefined): boolean {
  if (presented === undefined) {
    return false;
  }
  return timingSafeEqual(
    createHash('sha256').update(presented).digest(),
    createHash('sha256').update(edgeSecret()).digest(),
  );
}

/**
 * What every call this server makes to the API carries. Merged with a
 * caller's own headers rather than replacing them, so a JSON write keeps its
 * content type.
 */
export function edgeHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return { ...extra, [EDGE_SECRET_HEADER]: edgeSecret() };
}
