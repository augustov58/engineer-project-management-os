/**
 * The gate in front of every route (issue #105, ADR-0055).
 *
 * ADR-0020 put one long-lived shared secret here, and the cookie held the
 * secret itself — so this file could decide by comparing. It now holds an
 * opaque session id, and what can be decided here without a database is
 * whether the engineer has one at all. Whether it is still a session is the
 * API's answer, given on every request it validates (`apps/api/src/gate.ts`);
 * a browser carrying a revoked one is refused there and sent here by
 * `apiFetch`, which is the one door.
 *
 * `proxy.ts` and not `middleware.ts`: Next 16 deprecated that file convention
 * and renamed it, with the mechanism unchanged.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, SIGN_IN_PATH } from './app/session';

export const config = {
  /**
   * Everything except what Next serves as a static asset. Those carry no
   * record — the API's origin is not even in the client bundles — and gating
   * them would leave the sign-in screen itself styleless in front of an
   * engineer who has no way in yet.
   *
   * `/sign-in` is deliberately **not** excluded here. A path a matcher skips
   * is a path this file never sees, and a server action is a POST to the
   * route it is used on, so an exclusion silently un-gates that route's
   * actions as well. Everything is matched; the one exemption is below,
   * where it can be read.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // An empty value is no cookie: a browser that has been handed `session=`
  // would otherwise get past here and be refused by the API one round trip
  // later, which is a redirect the engineer sees for no reason.
  const presented = request.cookies.get(SESSION_COOKIE)?.value;

  if (pathname === SIGN_IN_PATH || (presented !== undefined && presented !== '')) {
    return NextResponse.next();
  }

  /**
   * A page the engineer typed or followed a link to is sent to the sign-in
   * screen, and told where to come back to.
   *
   * Everything else is refused where it stands. An `EventSource` follows a
   * redirect, would parse the sign-in page as a stream, fail, and reconnect
   * forever without ever showing anybody an error — so the four live screens
   * get a 401 they can see. So do the server actions, whose reply is not a
   * document either.
   */
  const wantsPage =
    request.method === 'GET' &&
    (request.headers.get('accept') ?? '').includes('text/html');

  if (!wantsPage) {
    return NextResponse.json({ message: 'Not signed in.' }, { status: 401 });
  }

  const signIn = new URL(SIGN_IN_PATH, request.nextUrl);
  signIn.searchParams.set('next', pathname + request.nextUrl.search);
  return NextResponse.redirect(signIn);
}
