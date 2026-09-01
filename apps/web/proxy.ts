/**
 * The gate in front of every route (ADR-0020).
 *
 * ADR-0012 removed identity and could not remove access control: ADR-0003
 * puts real client work on a reachable URL, and between those two decisions
 * sat an application anybody with the URL could read. One long-lived shared
 * secret closes it. There is no session here and nothing to revoke — the
 * cookie holds the secret itself, so rotating it is a redeploy.
 *
 * `proxy.ts` and not `middleware.ts`: Next 16 deprecated that file convention
 * and renamed it, with the mechanism unchanged.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { EDGE_COOKIE, UNLOCK_PATH, unlocked } from './app/edge-secret';

export const config = {
  /**
   * Everything except what Next serves as a static asset. Those carry no
   * record — the API's origin is not even in the client bundles — and gating
   * them would leave the unlock screen itself styleless in front of an
   * engineer who has no way in yet.
   *
   * `/unlock` is deliberately **not** excluded here. A path a matcher skips
   * is a path this file never sees, and a server action is a POST to the
   * route it is used on, so an exclusion silently un-gates that route's
   * actions as well. Everything is matched; the one exemption is below,
   * where it can be read.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname === UNLOCK_PATH || unlocked(request.cookies.get(EDGE_COOKIE)?.value)) {
    return NextResponse.next();
  }

  /**
   * A page the engineer typed or followed a link to is sent to the unlock
   * screen, and told where to come back to.
   *
   * Everything else is refused where it stands. An `EventSource` follows a
   * redirect, would parse the unlock page as a stream, fail, and reconnect
   * forever without ever showing anybody an error — so the four live screens
   * get a 401 they can see. So do the server actions, whose reply is not a
   * document either.
   */
  const wantsPage =
    request.method === 'GET' &&
    (request.headers.get('accept') ?? '').includes('text/html');

  if (!wantsPage) {
    return NextResponse.json(
      { message: 'This deployment is gated. Present the shared secret.' },
      { status: 401 },
    );
  }

  const unlock = new URL(UNLOCK_PATH, request.nextUrl);
  unlock.searchParams.set('next', pathname + request.nextUrl.search);
  return NextResponse.redirect(unlock);
}
