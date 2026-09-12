/**
 * The session in front of every route (issue #105, ADR-0055), on this side of
 * it.
 *
 * The engineer signs in at `/sign-in` and the browser holds the **session id**
 * in a cookie, which `proxy.ts` checks in front of every page, every server
 * action and every proxy route. The Next server forwards that same id to the
 * API as a header, because no browser reaches the API — every call is made
 * here, which is the invariant ADR-0032 refused a presigned URL to keep.
 *
 * What replaced the shared secret is not the shape of this file but what the
 * value means: the cookie used to hold the secret itself, so there was nothing
 * to revoke and rotating it was a redeploy. It now holds an opaque id that
 * names a row, and signing out takes that row out on its own.
 *
 * Nothing here reads an environment variable, and there is no `NEXT_PUBLIC_`
 * name in this product that carries a credential: that prefix inlines a value
 * into every client bundle.
 */

/** Where the browser holds it. */
export const SESSION_COOKIE = 'session';

/** What the API reads it from, the same name `apps/api` writes down. */
export const SESSION_HEADER = 'x-session-id';

/** Where the engineer signs in, and the one path the gate lets by. */
export const SIGN_IN_PATH = '/sign-in';

/**
 * A year, matching what the API stamps on the row. Two places hold the same
 * number because they are two different facts that must agree: the browser
 * stops sending a cookie it has expired, and the API stops accepting a session
 * it has expired, and a browser that kept sending a dead one would show a
 * sign-in screen a moment later rather than a wrong answer.
 */
export const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * How the cookie is written, in the one place it is written from — the
 * sign-in action. `httpOnly` so no script can read it, and `secure` off over
 * plain HTTP because local development has no TLS and a secure cookie is never
 * sent back; a deployment is behind TLS (ADR-0003), which is where this
 * matters and where `NODE_ENV` is production.
 */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: SESSION_COOKIE_MAX_AGE,
} as const;
