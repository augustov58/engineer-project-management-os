/** The session record: signing in, signing out, and who is signed in (issue #105). */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit } from '../audit.js';
import {
  actorOf,
  callerOf,
  SESSION_LIFETIME_MS,
  newSessionId,
} from '../gate.js';
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

/**
 * Where a sign-in came from, as `apps/web` reported it (issue #125, ADR-0062).
 *
 * The same name `apps/web/app/session.ts` writes down, which is the second
 * header spelled on both sides of one wire and is spelled twice for
 * `x-session-id`'s reason: there is no module the two apps share.
 *
 * It is forwarded rather than read off the socket because **the API cannot
 * learn this for itself**. `index.ts` binds `127.0.0.1` and `fly.toml`
 * publishes only the Next server, so `request.ip` is loopback for the whole
 * internet. The header is trusted exactly as far as the session id arriving
 * beside it already is, and a forged one buys a stranger nothing: it moves
 * them to a fresh source count and leaves the count on the address they are
 * guessing at untouched.
 */
const SIGN_IN_SOURCE_HEADER = 'x-sign-in-source';

/**
 * How many refused attempts one address and one source get in the window.
 *
 * A count of the rows already here, dated by `attempted_at` and read through
 * the `TimeSource` — an arithmetic over the record rather than a counter
 * beside it, which is the shape ADR-0042 gave the ingest address's limit and
 * refused Redis for.
 *
 * **Fifteen minutes and not ADR-0042's hour**, and that is the one number here
 * with an argument behind it: the cost of that limit being wrong is a document
 * that arrives late, and the cost of this one being wrong is an engineer stood
 * in a building unable to start a walk — the one cost ADR-0020 says this
 * product cannot pay. So the window is what has to be short, and the counts sit
 * where a mistyped password is nowhere near them. The numbers themselves are
 * invented, as ADR-0042's were.
 */
const ADDRESS_LIMIT_PER_WINDOW = 10;

const SOURCE_LIMIT_PER_WINDOW = 30;

const SIGN_IN_WINDOW_MS = 15 * 60 * 1000;

/**
 * RFC 5321's maximum. An address longer than any address is not one, and
 * nothing else bounds this field: a body schema is what bounds every other
 * route's, and this is the one route that deliberately has none.
 */
const EMAIL_MAX = 254;

/**
 * Longer than an IPv6 address written out in full, which is 45 characters.
 * Same job as `EMAIL_MAX`: this route has no body schema and no header schema
 * either, so what is stored has to be bounded where it is read.
 */
const SOURCE_MAX = 64;

/** What a sign-in body must be, checked by hand rather than by a schema. */
function credentials(body: unknown): { email: string; password: string } | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const { email, password } = body as Record<string, unknown>;
  if (typeof email !== 'string' || typeof password !== 'string') {
    return null;
  }
  // Checked here beside the two type checks rather than as a rule of its own,
  // because it is the same question they are asking: this is a body that is
  // not credentials, and it gets the one refusal like every other (ADR-0062).
  if (email.length > EMAIL_MAX) {
    return null;
  }
  return { email, password };
}

/** Where the attempt came from, or null where nothing said. */
function sourceOf(request: FastifyRequest): string | null {
  const presented = request.headers[SIGN_IN_SOURCE_HEADER];
  const value = Array.isArray(presented) ? presented[0] : presented;
  if (value === undefined) {
    return null;
  }
  const source = value.trim();
  // Absent and unusable are one answer, and that answer costs something worth
  // naming: a caller with no usable source is counted by address alone, so a
  // header this refuses is a caller out of the source half of the limit. It is
  // the weaker half — the address count is what bounds a guess at an actual
  // account — and `apps/web` is the only sender, so the only way to arrive
  // here is to reach the API directly, which nothing outside the machine can.
  return source === '' || source.length > SOURCE_MAX ? null : source;
}

/**
 * Whether this address from this source, or this source at all, has had its
 * quarter-hour's worth.
 *
 * **The address count carries the source**, which is what keeps a stranger
 * from doing the one thing ADR-0062 says nothing here may do. Counting the
 * address alone, somebody who knew an engineer's address could spend its ten
 * and hold that engineer out of a walk indefinitely — a request every ninety
 * seconds renews it, `user reset` does not clear it, because the count is on
 * the address and not on the credential. With the source on it the stranger
 * spends their own ten at their own source and the phone in the engineer's
 * pocket still has all of its. What this gives up is bounding a **distributed**
 * guess at one account, which is the gap that record already names as bounded
 * by nothing; guessing from one place, which is the real case, is still ten.
 *
 * **Counted once and not twice**, which is where this departs from ADR-0042
 * and is recorded in ADR-0062 rather than left to be found. That limit stands
 * in the gate's place on the one route reachable without it, so a burst walking
 * through it is a burst walking through the gate; this one stands behind the
 * password and behind argon2id, so a burst that races past the count by a
 * handful has bought a handful of extra guesses at a twelve-character minimum.
 * And the only key available here is the address the caller typed, so the
 * advisory lock that makes ADR-0042's count a bound would be one a stranger
 * could hold against a real engineer's own sign-in.
 */
async function overTheLimit(
  prisma: RouteDependencies['prisma'],
  email: string,
  source: string | null,
  now: Date,
): Promise<boolean> {
  const since = new Date(now.getTime() - SIGN_IN_WINDOW_MS);
  const [againstAddress, fromSource] = await Promise.all([
    prisma.signInFailure.count({
      where: { email, source, attemptedAt: { gte: since } },
    }),
    source === null
      ? 0
      : prisma.signInFailure.count({
          where: { source, attemptedAt: { gte: since } },
        }),
  ]);
  return (
    againstAddress >= ADDRESS_LIMIT_PER_WINDOW ||
    fromSource >= SOURCE_LIMIT_PER_WINDOW
  );
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
      // Nothing to file a row under, and the sweep in `test/gate.test.ts`
      // makes one of these against every route the API registers.
      return refuse(reply, NOT_AN_ACCOUNT);
    }

    const now = timeSource.now();
    const source = sourceOf(request);

    // Before the hash is verified, which is the whole point: until issue #125
    // argon2id was the only thing slowing a guess down (ADR-0055's own gap).
    // A caller refused here is told nothing new and **writes no row** — a
    // refused write writes none, and it is what keeps the window rolling
    // rather than extending itself every time somebody knocks.
    if (await overTheLimit(prisma, presented.email, source, now)) {
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
      // The record the limit above counts (issue #125, ADR-0062). Written on
      // all three ways of not being an account, so the row costs the same
      // whether the address is one or not — the property `unmatchableHash`
      // exists to give the clock, kept here for the table.
      //
      // The address goes in exactly as presented and is not normalised: only
      // the exact spelling can ever sign in, so only the exact spelling is
      // worth bounding. It is not an audit line and could not be one — nothing
      // was mutated and the caller has no session to take an actor from.
      await prisma.signInFailure.create({
        data: { email: presented.email, source, attemptedAt: now },
      });
      return refuse(reply, NOT_AN_ACCOUNT);
    }

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
      // #105). The subject is the **user** and never the session: a session
      // id is the credential itself, and this table is append-only, read on
      // a screen and exported whole (issue #111).
      //
      // The actor is spelled here rather than read from `actorOf`, because
      // this is the one gated-past route where the caller has just been
      // authenticated and has no session yet — signing in is the act of
      // getting one. It is still the session's user: this route worked out
      // who, which is what `actorOf` does everywhere else.
      await audit(tx, {
        projectId: null,
        actor: { userId: user.id, agentRunId: null, extractionId: null },
        subject: { type: 'user', id: user.id },
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

  /**
   * Who this request is. The gate refused it already if it is nobody.
   *
   * The one read that carries a field `userOnTheWire` does not: the signed-in
   * person's **theme** (issue #117). That projection is the three fields a
   * name on a record needs and is spread across half the product — a walk's
   * conducted-by, an item's owner, the people list — and a theme on every one
   * of those would be a field on the wire that no screen reads. Here it has a
   * reader: the root layout writes the class on `<html>` off this read, which
   * it was already making, so the override costs no second request.
   */
  v1.get('/sessions/current', async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: callerOf(request).userId },
    });
    if (user === null) {
      return refuse(reply, NOT_AN_ACCOUNT);
    }
    return reply.send({ ...userOnTheWire(user), theme: user.theme });
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
        actor: actorOf(request),
        subject: { type: 'user', id: callerOf(request).userId },
        action: 'signed out',
        detail: 'one session revoked',
        at: now,
      });
    });

    return reply.code(204).send();
  });
}
