/** The session record: signing in, signing out, and who is signed in (issue #105). */

import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.js';
import { callerOf, SESSION_LIFETIME_MS, newSessionId } from '../gate.js';
import type { RouteDependencies } from '../http.js';
import { passwordMatches, unmatchableHash } from '../passwords.js';
import { refuse, type Refusal } from '../refusals.js';
import { userOnTheWire } from '../wire.js';

/**
 * One sentence for a wrong password, an address with no account, a disabled
 * account and a request carrying no body at all — there is nothing here to
 * tell apart, and a longer answer would describe the shape of the thing being
 * guessed. The same code the gate answers, so the sweep over every route sees
 * one shape (`src/gate.ts`).
 */
const NOT_AN_ACCOUNT: Refusal = {
  code: 401,
  message: 'That is not an account here, or not its password.',
};

/** What a sign-in body must be, checked by hand rather than by a schema. */
function credentials(body: unknown): { email: string; password: string } | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const { email, password } = body as Record<string, unknown>;
  if (typeof email !== 'string' || typeof password !== 'string') {
    return null;
  }
  return { email, password };
}

export function sessionRoutes(
  v1: FastifyInstance,
  { prisma, timeSource }: RouteDependencies,
): void {
  /**
   * Sign in.
   *
   * **No body schema, deliberately** — the one route in the product without
   * one. The gate steps aside here so that the route can authenticate its own
   * caller (`src/gate.ts`), and a schema would answer a bodyless POST with a
   * 400: the sweep in `test/gate.test.ts` would then read this as a route an
   * anonymous caller gets something other than a 401 from, and the shape of
   * the request would be something a stranger could learn by probing. So the
   * body is read by hand and every failure is the one refusal above.
   */
  v1.post('/sessions', async (request, reply) => {
    const presented = credentials(request.body);
    if (presented === null) {
      return refuse(reply, NOT_AN_ACCOUNT);
    }

    const user = await prisma.user.findUnique({
      where: { email: presented.email },
    });
    // The hash is verified even when there is no such account, against a
    // hash of this process's own making, so that "no account" and "wrong
    // password" cost the same and the difference is not readable off a clock.
    const encoded = user?.passwordHash ?? (await unmatchableHash());
    const matches = await passwordMatches(encoded, presented.password);

    if (user === null || !matches || user.disabledAt !== null) {
      return refuse(reply, NOT_AN_ACCOUNT);
    }

    const now = timeSource.now();
    const session = await prisma.$transaction(async (tx) => {
      const created = await tx.session.create({
        data: {
          id: newSessionId(),
          userId: user.id,
          createdAt: now,
          expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS),
        },
      });
      // The firm's line and not a job's, so it carries no project (issue
      // #105). The id is never named: it is the credential itself.
      await audit(tx, {
        projectId: null,
        action: 'signed in',
        detail: user.email,
        at: now,
      });
      return created;
    });

    return reply.code(201).send({
      id: session.id,
      expiresAt: session.expiresAt.toISOString(),
      user: userOnTheWire(user),
    });
  });

  /** Who this request is. The gate refused it already if it is nobody. */
  v1.get('/sessions/current', async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: callerOf(request).userId },
    });
    if (user === null) {
      return refuse(reply, NOT_AN_ACCOUNT);
    }
    return reply.send(userOnTheWire(user));
  });

  /**
   * Sign out: revoke **this** session and no other.
   *
   * Per row, which is the property the shared secret never had (ADR-0055).
   * Signing out of a phone leaves the laptop signed in, and a second sign-out
   * writes nothing — a no-op writes no audit line either (ADR-0040's rule).
   */
  v1.delete('/sessions/current', async (request, reply) => {
    const now = timeSource.now();
    const id = callerOf(request).id;

    await prisma.$transaction(async (tx) => {
      const { count } = await tx.session.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt: now },
      });
      if (count === 0) {
        // Already revoked. The answer is the same either way — the caller is
        // signed out — and a no-op writes no audit line (ADR-0040's rule).
        return;
      }
      await audit(tx, {
        projectId: null,
        action: 'signed out',
        detail: 'one session revoked',
        at: now,
      });
    });

    return reply.code(204).send();
  });
}
