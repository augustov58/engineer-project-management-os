/**
 * Writing a `users` row, and the one way one is written (issue #105).
 *
 * A **leaf** in ADR-0033's sense, and one from its first line rather than
 * after a move, for `zone.ts`'s reason: it had two readers before it had one.
 * `routes/users.ts` is how a signed-in engineer adds the next account and
 * `user-command.ts` is how the first one exists at all, and both must write
 * the row, hash the password and write the audit line in a single
 * transaction. A second copy of that sequence is a second place one of the
 * three could be left out.
 *
 * It is named for the table it writes, as `audit.ts` is; `routes/users.ts` is
 * named for the record, as ADR-0033 requires of a route file.
 */

import type { Prisma } from '../generated/prisma/client.js';
import { audit, NO_ACTOR, type Actor } from './audit.js';
import { hashPassword } from './passwords.js';

/** Everything an account needs, and nothing about what it may do. */
export interface NewUser {
  name: string;
  email: string;
  password: string;
}

/**
 * Add an account, inside the caller's transaction, with the audit line beside
 * it (story 106). Throws Prisma's unique violation if the address is taken —
 * the caller decides whether that is a 409 or a sentence on a terminal.
 *
 * The line carries no project: this is the firm's mutation, not a job's
 * (issue #105). It names the address and never the password or its hash.
 */
export async function createUser(
  tx: Prisma.TransactionClient,
  { name, email, password }: NewUser,
  at: Date,
  actor: Actor,
): Promise<{ id: string; name: string; email: string }> {
  // Hashed before the write and not inside it. argon2id is deliberately tens
  // of milliseconds of CPU, and doing it in the `create` argument would hold
  // an open interactive transaction and its pooled connection for all of them
  // — against Prisma's five-second ceiling, under every concurrent caller. It
  // needs nothing from `tx`.
  const passwordHash = await hashPassword(password);
  const created = await tx.user.create({
    data: { name, email, passwordHash, createdAt: at },
  });
  await audit(tx, {
    projectId: null,
    actor,
    subject: { type: 'user', id: created.id },
    action: 'user recorded',
    detail: `${created.name} — ${created.email}`,
    at,
  });
  return { id: created.id, name: created.name, email: created.email };
}

/**
 * Set an account's password, inside the caller's transaction (ADR-0055 part
 * 7). The machine command is the only caller: a reset over mail is a consent
 * case of its own and is deferred with a named trigger.
 *
 * **Every one of that account's live sessions is revoked in the same
 * transaction.** A password changed because it may be known is not changed at
 * all while the browser that knew it stays signed in — the point of a session
 * being a row is that this is one statement.
 *
 * Answers false where no such address exists, so the command says so rather
 * than reporting a reset that did not happen.
 */
export async function resetPassword(
  tx: Prisma.TransactionClient,
  email: string,
  password: string,
  at: Date,
): Promise<boolean> {
  // Outside the write, for `createUser`'s reason.
  const passwordHash = await hashPassword(password);

  // The command is given an address and the line names the row (issue #111),
  // so the account is resolved before anything is written to it. This is also
  // the "no such address" answer, which the count of an `updateMany` on the
  // address was before.
  const account = await tx.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (account === null) {
    return false;
  }

  await tx.user.update({
    where: { id: account.id },
    data: { passwordHash },
  });

  await tx.session.updateMany({
    where: { userId: account.id, revokedAt: null },
    data: { revokedAt: at },
  });

  // No actor: this runs on the machine, where nobody is signed in. The one
  // route with no actor is the ingest webhook (ADR-0042); the other two
  // actorless lines are this and `enableUser`, and both are commands rather
  // than requests.
  await audit(tx, {
    projectId: null,
    actor: NO_ACTOR,
    subject: { type: 'user', id: account.id },
    action: 'password reset',
    detail: `${email}, and every session of theirs revoked`,
    at,
  });
  return true;
}

/**
 * Turn an account back on (issue #105).
 *
 * The way back from a closed account, and the reason `POST /v1/users/:id/disable`
 * is not a one-way door: everyone at the firm may close an account, including
 * the last one, and a deployment whose only account is closed can be reached
 * by nobody through the interface. That is the same hole the first account
 * falls through, and it has the same floor — somebody at the machine.
 *
 * It does **not** restore the sessions disabling revoked: those are gone on
 * purpose, and signing in again is the way on.
 *
 * Answers false where no such address exists.
 */
export async function enableUser(
  tx: Prisma.TransactionClient,
  email: string,
  at: Date,
): Promise<boolean> {
  // Resolved first so the line names the row, as `resetPassword` does. The
  // `disabled_at` stays in the `where` and the count is still checked: an
  // account already open is a no-op and writes no line, which is what stops
  // a second `enable` claiming something happened.
  const account = await tx.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (account === null) {
    return false;
  }
  const { count } = await tx.user.updateMany({
    where: { id: account.id, disabledAt: { not: null } },
    data: { disabledAt: null },
  });
  if (count === 0) {
    return false;
  }
  await audit(tx, {
    projectId: null,
    actor: NO_ACTOR,
    subject: { type: 'user', id: account.id },
    action: 'user enabled',
    detail: email,
    at,
  });
  return true;
}
