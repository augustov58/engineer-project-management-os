import { apiFetch } from '../api';

/**
 * Never cached and never prerendered. `apiFetch` reads `cookies()`, which
 * forces this dynamic on its own, so this line is a statement of intent rather
 * than a load-bearing one: a health check answered from a cache is a check on
 * the cache.
 */
export const dynamic = 'force-dynamic';

/**
 * Under Fly's own `timeout = "5s"`, so a wedged API is reported by this route
 * as a 503 rather than left for the platform to give up on. The same machine
 * gets restarted either way; this way the reason is in the access log.
 */
const ANSWER_WITHIN_MS = 3_000;

/**
 * The platform's health check, which reaches the API (issue #106, ADR-0052).
 *
 * ADR-0045 put the check on `/unlock` and issue #105 moved it to `/sign-in`,
 * both served entirely by Next and both calling nothing. Either one proved the
 * Next server was serving and said nothing about the other half, so an API
 * that was OOM-killed or wedged — a plausible outcome of ordinary use on a
 * 1 gb machine shared with Chrome — left a machine Fly kept alive, serving a
 * frontend whose every read and write failed (issue #94).
 *
 * It goes through `apiFetch` because that is the one door (ADR-0055). A second
 * `fetch` here would be the second call site the session was first spelled at
 * twenty-five of, and `apps/web/test/session.test.ts` would say so.
 *
 * **What it proves:** the API process accepted the connection, ran its gate
 * and replied. **What it does not:** that its database and Redis are up.
 * `GET /v1/health` answers that and is gated deliberately, because one named
 * exemption is a property a test can hold and two is the start of a list — so
 * a check carrying no session gets the gate's 401 instead, and reads it as the
 * answer it is. That is the half of #94 that was invisible; the other half, an
 * API that exited, `scripts/start.sh` already takes the machine down for.
 */
export async function GET(): Promise<Response> {
  try {
    const answer = await apiFetch('/health', {
      cache: 'no-store',
      // A third reader that must be able to hear *nobody*: this caller has no
      // session and never will, and the default would send a health check to
      // the sign-in screen.
      refusal: 'answer',
      signal: AbortSignal.timeout(ANSWER_WITHIN_MS),
    });
    // Read and dropped rather than left on the floor. Nothing here wants the
    // body, and an undrained one holds its socket open until the garbage
    // collector gets to it — every thirty seconds, forever, on a machine whose
    // memory is the reason this check exists.
    await answer.body?.cancel();
  } catch {
    // A connection refused by a dead process, or a request abandoned at the
    // timeout above. Both are the API not answering, which is the one thing
    // this route is here to notice.
    return new Response(null, { status: 503 });
  }

  // The status line and nothing else. ADR-0020 gated the health route because
  // "an anonymous caller learning whether this instance's database and Redis
  // are up is a fact worth nothing to the engineer and something to somebody
  // else", and this path is reachable without a session, so what it hands back
  // is the one bit the platform needs.
  return new Response(null, { status: 200 });
}
