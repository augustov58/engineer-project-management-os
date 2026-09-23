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

/**
 * Where a sign-in came from, as the API reads it (issue #125, ADR-0062).
 *
 * The same name `apps/api/src/routes/sessions.ts` writes down, spelled twice
 * for the reason `x-session-id` is: there is no module the two apps share.
 *
 * It is sent on the **sign-in call and on no other**, because it is counted on
 * no other: the throttle in front of `POST /v1/sessions` bounds refused
 * attempts per address and per source, and the API cannot learn a source for
 * itself — it binds loopback, and every request it sees is made by this server.
 */
export const SIGN_IN_SOURCE_HEADER = 'x-sign-in-source';

/**
 * Where Fly's proxy puts the engineer's own address, and **the only header
 * read for it**.
 *
 * `x-forwarded-for` is deliberately not a fallback. Fly overwrites this header
 * on every request, so it is the proxy's word; `x-forwarded-for` is a header a
 * *browser* can set on its own request to this server, and honouring one would
 * let a stranger spend somebody else's thirty attempts by naming their address
 * — a stranger doing to an engineer the one thing ADR-0062 says nothing here
 * may do. Null under `pnpm dev`, where there is no proxy and the source half of
 * the limit simply does not apply.
 */
export const SOURCE_HEADER = 'fly-client-ip';

/**
 * Where the engineer signs in, and the one path the gate lets a *person* by.
 *
 * Since issue #106 `proxy.ts` lets a second path by, `/healthz`, which no
 * person asks for: it is the platform's health check, it renders nothing, and
 * it is spelled where it is exempted rather than here.
 */
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
