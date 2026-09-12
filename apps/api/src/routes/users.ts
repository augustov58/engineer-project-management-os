/** The user record: the people at the firm (issue #105, ADR-0055). */

import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.js';
import { NOT_BLANK, isUniqueViolation, type RouteDependencies } from '../http.js';
import { MINIMUM_PASSWORD_LENGTH } from '../passwords.js';
import { createUser } from '../users.js';
import { userOnTheWire } from '../wire.js';

/**
 * The address is `\S+@\S+` and no more. A pattern that tried to be RFC 5322
 * would refuse real addresses; what this column needs is that two accounts
 * cannot collide and that the thing typed is recognisably an address, and the
 * unique index is the half that matters.
 *
 * The password's only rule is a length (ADR-0055 part 7 has no reset that does
 * not go through the author at a laptop, so a composition rule would cost more
 * than it buys).
 */
const userBodySchema = {
  type: 'object',
  required: ['name', 'email', 'password'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', pattern: NOT_BLANK, maxLength: 200 },
    email: { type: 'string', pattern: '^\\S+@\\S+$', maxLength: 320 },
    password: { type: 'string', minLength: MINIMUM_PASSWORD_LENGTH, maxLength: 1024 },
  },
} as const;

export function userRoutes(
  v1: FastifyInstance,
  { prisma, timeSource }: RouteDependencies,
): void {
  /** Everyone at the firm. No hash on the wire, ever. */
  v1.get('/users', async () => {
    const users = await prisma.user.findMany({ orderBy: { name: 'asc' } });
    return users.map(userOnTheWire);
  });

  /**
   * Add an account.
   *
   * **Any signed-in user may**, and there is no role that says who (ADR-0055
   * part 7): accounts are recorded rather than prevented, and the audit line
   * written beside the row is what records them. The named trigger that would
   * reverse it is the first time one engineer must be *prevented* from doing
   * something rather than *recorded* doing it.
   */
  v1.post<{ Body: { name: string; email: string; password: string } }>(
    '/users',
    { schema: { body: userBodySchema } },
    async (request, reply) => {
      try {
        const at = timeSource.now();
        const user = await prisma.$transaction((tx) =>
          createUser(tx, request.body, at),
        );
        return reply.code(201).send(user);
      } catch (error) {
        if (isUniqueViolation(error)) {
          return reply
            .code(409)
            .send({ message: 'that email address already has an account' });
        }
        throw error;
      }
    },
  );

  /**
   * Turn an account off.
   *
   * A stamp and never a delete: the rows that account wrote stay theirs, and
   * `users.disabled_at` is what the gate reads on every request — so a
   * disabled account cannot sign in and the sessions it already had stop
   * validating in the same instant. Both halves are written here: revoking
   * them is what makes "cannot sign in" true of the phone in somebody's
   * pocket and not only of the sign-in screen.
   *
   * Any signed-in user may, as any may add one (ADR-0055 part 7): the closing
   * of an account is recorded rather than prevented. A second disable is a
   * no-op and writes no line, as a second archive does.
   */
  v1.post<{ Params: { id: string } }>(
    '/users/:id/disable',
    async (request, reply) => {
      const user = await prisma.user.findUnique({
        where: { id: request.params.id },
      });
      if (user === null) {
        return reply.code(404).send({ message: 'no user with that id' });
      }
      if (user.disabledAt !== null) {
        // A second disable is a no-op and writes no line, as a second archive
        // does (ADR-0040's rule).
        return reply.send(userOnTheWire(user));
      }

      const at = timeSource.now();
      await prisma.$transaction(async (tx) => {
        const { count } = await tx.user.updateMany({
          where: { id: user.id, disabledAt: null },
          data: { disabledAt: at },
        });
        if (count === 0) {
          // Two requests read the account open and both got here; the one
          // that wrote the stamp wrote the line, and this one writes neither.
          return;
        }
        await tx.session.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: at },
        });
        await audit(tx, {
          projectId: null,
          action: 'user disabled',
          detail: `${user.name} — ${user.email}, and every session of theirs revoked`,
          at,
        });
      });

      return reply.send(userOnTheWire(user));
    },
  );
}
