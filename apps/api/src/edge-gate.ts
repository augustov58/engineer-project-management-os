/**
 * The gate in front of every route (ADR-0020).
 *
 * ADR-0012 removed **identity** — there is no `users` table, no role and no
 * permission, and this adds none. It could not remove **access control**:
 * ADR-0003 puts real client work on a reachable URL, and between those two
 * decisions sat an application anybody with the URL could read. One
 * long-lived shared secret closes that, and nothing here is a session: there
 * is no state to revoke, so rotating the secret is a redeploy.
 *
 * The engineer presents it once and the browser holds it in a cookie, which
 * `apps/web/proxy.ts` checks. It reaches *this* service as a header, because
 * a cookie is how a browser carries a credential and no browser reaches this
 * API — every call is made by the Next server, an invariant this product
 * already holds for its own reasons, and by the agent's domain tools over
 * loopback. A cookie reader here would be machinery for a caller that does
 * not exist.
 *
 * A leaf, in ADR-0033's sense: it imports Fastify and this product's refusal
 * shape and nothing from a route module.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { refuse, type Refusal } from './refusals.js';

/** What a caller presents it in. Lower-case: Node gives headers that way. */
export const EDGE_SECRET_HEADER = 'x-edge-secret';

/**
 * The one path the gate lets through, and the only one ADR-0020 carves out.
 *
 * Inbound mail cannot present anything: a provider posts to an address it was
 * given, and the address's own unguessability and the rate limit beneath it
 * are what stand in the gate's place there (ADR-0042). `GET /v1/health` was
 * the other candidate and is deliberately **not** here — a managed platform's
 * HTTP check must be configured to send the header or be a TCP check
 * instead, because one named exception is a property a test can hold and two
 * is the start of a list.
 */
const EXEMPT = new Set(['POST /v1/ingest/inbound-mail']);

const NOT_PRESENTED: Refusal = {
  code: 401,
  message: 'This deployment is gated. Present the shared secret.',
};

/**
 * Whether two secrets are the same, in time that does not depend on how much
 * of one is right. `timingSafeEqual` throws on differing lengths, so both are
 * digested first: the comparison is then always over 32 bytes and the length
 * of a guess leaks nothing either.
 */
function sameSecret(presented: string, expected: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(presented).digest(),
    createHash('sha256').update(expected).digest(),
  );
}

/**
 * Refuse anything that does not carry the secret, before the route runs.
 *
 * `onRequest` is the first hook in Fastify's lifecycle and runs after routing
 * and before a body is parsed, a schema is checked or a handler hijacks the
 * socket — so a stranger's request costs a header comparison, an SSE route is
 * never left half-open by a refusal, and the answer cannot depend on whether
 * the record named in the path exists.
 *
 * Registered on the root instance rather than inside the `/v1` context, so it
 * covers anything ever mounted outside that prefix as well. This is the
 * boundary's own machinery, which is why `server.ts` calls it (ADR-0033).
 */
export function edgeGate(app: FastifyInstance, secret: string): void {
  app.addHook('onRequest', async (request, reply) => {
    // Query stripped, so `?` cannot be used to dress a path up as the exempt
    // one. Fastify's raw url is the path exactly as it was routed.
    const path = request.url.split('?')[0] ?? '';
    if (EXEMPT.has(`${request.method} ${path}`)) {
      return;
    }

    const presented = request.headers[EDGE_SECRET_HEADER];
    if (typeof presented !== 'string' || !sameSecret(presented, secret)) {
      return refuse(reply, NOT_PRESENTED);
    }
  });
}
