/**
 * The gate in front of every route (issue #105, ADR-0055).
 *
 * ADR-0020 put one long-lived shared secret here and named its own
 * replacement clause: *"when multi-user arrives it will be a migration that
 * introduces identity, and this gate is replaced rather than extended."* This
 * is that replacement. A caller presents a **session** — a row in `sessions`,
 * revocable on its own, belonging to a person — and the three properties
 * ADR-0055 kept from the secret are kept here: the exempt set is one route and
 * a sweep proves it, `apiFetch` is still the only thing in `apps/web` that
 * reaches this API, and nothing was added between the engineer and a walk.
 *
 * The secret and the session are **not** two mechanisms for one fact, and
 * neither were the cookie and the header before them. A cookie is how a
 * *browser* carries a credential, and no browser reaches this API — every call
 * is made by the Next server or by an agent run over loopback, which is why
 * ADR-0032 refused a presigned URL. A cookie reader here would be machinery
 * for a caller that does not exist.
 *
 * A leaf, in ADR-0033's sense: it imports Prisma's and Fastify's types and
 * this product's refusal shape, and nothing from a route module.
 */

import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { refuse, type Refusal } from './refusals.js';
import type { TimeSource } from './time-source.js';

/** What a caller presents it in. Lower-case: Node gives headers that way. */
export const SESSION_HEADER = 'x-session-id';

/**
 * The one path the gate lets through with nothing at all, and the only one
 * ADR-0020 carved out — unchanged by ADR-0055, which keeps it by name.
 *
 * Inbound mail cannot present anything: a provider posts to an address it was
 * given, and the address's own unguessability and the rate limit beneath it
 * are what stand in the gate's place there (ADR-0042). `GET /v1/health` was
 * the other candidate and is deliberately **not** here — a managed platform's
 * HTTP check must be configured to send a session or be a TCP check instead,
 * because one named exception is a property a test can hold and two is the
 * start of a list.
 */
const EXEMPT = new Set(['POST /v1/ingest/inbound-mail']);

/**
 * Where a session is *obtained*, which is not the same thing as being exempt
 * from needing one — and is why this is a second constant rather than a second
 * entry in the set above.
 *
 * `POST /v1/sessions` presents a credential like every other route; it
 * presents an email and a password instead of a session id, and it
 * authenticates its own caller. So the gate steps aside and the route refuses
 * — with **401**, the same code the gate answers — for a wrong password, an
 * unknown address and a request carrying no body at all alike. The sweep in
 * `test/gate.test.ts` therefore still reads the ingest webhook as the one
 * route an anonymous caller gets anything but a 401 from, unchanged, which is
 * what ADR-0055 asks of it.
 *
 * That is also why the sign-in route declares **no body schema**: a schema
 * would answer a bodyless POST with a 400, and the shape of the request would
 * become something an anonymous caller could learn by probing.
 */
const SIGN_IN = 'POST /v1/sessions';

/**
 * One sentence for no session, an unknown one, a revoked one, an expired one
 * and a disabled user's — there is nothing here worth telling apart, and a
 * longer answer would only describe the state of a credential to somebody who
 * does not hold it.
 */
const NOT_SIGNED_IN: Refusal = {
  code: 401,
  message: 'Not signed in.',
};

/** A year, as the unlock cookie was: a walk must never wait on a sign-in. */
export const SESSION_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * A session's id, which **is** the credential.
 *
 * 32 bytes from the CSPRNG rather than a `uuid()` default on the column: a
 * default would be a second place the value could come from, and a v4 uuid
 * reads like a record id — something this product shows on screens and puts in
 * paths. This one is never shown.
 */
export function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

/** The caller, as the boundary worked it out. */
export interface CallerSession {
  id: string;
  userId: string;
  /** Set where this session was minted for a run rather than for a person. */
  agentRunId: string | null;
  extractionId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The session this request came in on, or null on the two routes that
     * have none: the ingest webhook and the sign-in route itself.
     */
    session: CallerSession | null;
  }
}

/**
 * Refuse anything that does not carry a live session, before the route runs.
 *
 * `onRequest` is the first hook in Fastify's lifecycle and runs after routing
 * and before a body is parsed, a schema is checked or a handler hijacks the
 * socket — so a stranger's request costs one indexed lookup, an SSE route is
 * never left half-open by a refusal, and the answer cannot depend on whether
 * the record named in the path exists.
 *
 * Registered on the root instance rather than inside the `/v1` context, so it
 * covers anything ever mounted outside that prefix as well. This is the
 * boundary's own machinery, which is why `server.ts` calls it (ADR-0033).
 */
export function gate(
  app: FastifyInstance,
  { prisma, timeSource }: { prisma: PrismaClient; timeSource: TimeSource },
): void {
  app.decorateRequest('session', null);

  app.addHook('onRequest', async (request, reply) => {
    // Query stripped, so `?` cannot be used to dress a path up as the exempt
    // one. Fastify's raw url is the path exactly as it was routed.
    const path = request.url.split('?')[0] ?? '';
    const route = `${request.method} ${path}`;
    if (EXEMPT.has(route) || route === SIGN_IN) {
      return;
    }

    const presented = request.headers[SESSION_HEADER];
    if (typeof presented !== 'string') {
      return refuse(reply, NOT_SIGNED_IN);
    }

    const session = await prisma.session.findUnique({
      where: { id: presented },
      select: {
        id: true,
        userId: true,
        agentRunId: true,
        extractionId: true,
        expiresAt: true,
        revokedAt: true,
        user: { select: { disabledAt: true } },
      },
    });

    // Every way of not being signed in, answered identically. Expiry is read
    // against the injected TimeSource and never the database's clock, so a
    // test ages a session by advancing a fake rather than by sleeping
    // (ADR-0022).
    if (
      session === null ||
      session.revokedAt !== null ||
      session.expiresAt <= timeSource.now() ||
      session.user.disabledAt !== null
    ) {
      return refuse(reply, NOT_SIGNED_IN);
    }

    request.session = {
      id: session.id,
      userId: session.userId,
      agentRunId: session.agentRunId,
      extractionId: session.extractionId,
    };
  });
}

/**
 * The person behind a request the gate let through.
 *
 * Every route but the ingest webhook and the sign-in route has one, because
 * the hook above refuses before a handler runs. The throw is for the
 * unreachable case rather than a check: a handler that found itself without a
 * caller has a boundary that stopped working, and continuing would write a row
 * nobody is answerable for.
 */
export function callerOf(request: FastifyRequest): CallerSession {
  if (request.session === null) {
    throw new Error('a gated route ran with no session');
  }
  return request.session;
}

/**
 * How long a run-scoped session lives if nothing revokes it first.
 *
 * A day, against a person's year: this is a credential a background job holds,
 * and the worker revokes it the moment the run settles either way. The bound
 * is what covers the ways a run never settles — the process killed mid-run,
 * a job left stalled in Redis — so that a dead run's credential is not a live
 * one for a year.
 */
export const RUN_SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Which record a run-scoped session belongs to. Exactly one, by CHECK. */
export type RunLink = { agentRunId: string } | { extractionId: string };

/**
 * Mint the session a run's agent calls the API under, inside the transaction
 * that writes the run (issue #105, ADR-0055 part 6).
 *
 * **In the name of the person who asked for the run**, so every route the
 * agent's tools call sees a person and a run and neither has to be invented
 * later. The agent is never an actor itself.
 *
 * Minted here and not in the worker, and looked up through this row rather
 * than carried in the job: a queue payload is a place a live credential would
 * sit, readable and outliving a stalled job, and the link column is a place it
 * already has to be.
 */
export async function mintRunSession(
  tx: Prisma.TransactionClient,
  link: RunLink,
  userId: string,
  at: Date,
): Promise<string> {
  const session = await tx.session.create({
    data: {
      id: newSessionId(),
      userId,
      createdAt: at,
      expiresAt: new Date(at.getTime() + RUN_SESSION_LIFETIME_MS),
      ...link,
    },
  });
  return session.id;
}

/** The live session minted for this run, or null if it has none. */
async function runSession(
  prisma: PrismaClient,
  link: RunLink,
): Promise<string | null> {
  const session = await prisma.session.findFirst({
    where: { ...link, revokedAt: null },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
  });
  return session?.id ?? null;
}

/**
 * Run a job's agent under the session minted for it, and take that session
 * away when the job settles.
 *
 * One function rather than the lookup and the revoke spelled at each of the
 * worker's two run handlers: the revoke is in a `finally`, so **"expiring when
 * the run ends" is a fact about this function** rather than about two handlers
 * both remembering. A handler that forgot would leave a live credential behind
 * for the day the expiry allows, and nothing would fail.
 *
 * A run with no session fails here, with a sentence, rather than in every tool
 * call it would go on to make with nothing to present.
 *
 * `updateMany` on the way out rather than an update by id, so a redelivered
 * job that settled the run once already revokes nothing a second time rather
 * than failing.
 */
export async function underRunSession<T>(
  prisma: PrismaClient,
  link: RunLink,
  timeSource: TimeSource,
  run: (sessionId: string) => Promise<T>,
): Promise<T> {
  try {
    const sessionId = await runSession(prisma, link);
    if (sessionId === null) {
      throw new Error('the run has no session to call the API under');
    }
    return await run(sessionId);
  } finally {
    await prisma.session.updateMany({
      where: { ...link, revokedAt: null },
      data: { revokedAt: timeSource.now() },
    });
  }
}
