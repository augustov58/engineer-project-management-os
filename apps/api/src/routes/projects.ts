/** The project record: the row every other record hangs off (issue #3). */

import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { type RouteDependencies, isUniqueViolation } from '../http.js';
import { noSuchProject } from '../refusals.js';
import { projectOnTheWire } from '../wire.js';

/**
 * No format for the project number is written down anywhere — only that it is
 * short, unique and immutable. `^\S+$` is that read literally: an identifier
 * you can say out loud and paste into an email subject, so no whitespace and
 * nothing long enough to stop being short.
 */
const projectBodySchema = {
  type: 'object',
  required: ['projectNumber', 'name'],
  additionalProperties: false,
  properties: {
    projectNumber: { type: 'string', pattern: '^\\S+$', maxLength: 32 },
    name: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const;

/**
 * Which half of the register to list. Archiving is the only thing that moves a
 * project between them, so one flag covers both screens.
 */
const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { archived: { type: 'boolean', default: false } },
} as const;

/**
 * The secret half of a job's forward-to-ingest address (issue #19, story 83).
 *
 * Twenty-four bytes from the CSPRNG, base64url so it is safe as an email
 * local part and as a path segment. It is the only credential on a path that
 * bypasses the interface entirely — ADR-0020 carves the ingest addresses out
 * of the edge gate by name and says their unguessability stays load-bearing —
 * so this comes from `randomBytes` and never from `Math.random`, and it
 * shares nothing with the project number, which ADR-0009's
 * `rfi+{project-key}@...` sketch would have made guessable off any document
 * header (ADR-0042).
 */
function newIngestToken(): string {
  return randomBytes(24).toString('base64url');
}

export function projectRoutes(
  v1: FastifyInstance,
  { prisma, timeSource, ingestDomain }: RouteDependencies,
): void {
  v1.post<{ Body: { projectNumber: string; name: string } }>(
    '/projects',
    { schema: { body: projectBodySchema } },
    async (request, reply) => {
      try {
        const now = timeSource.now();
        const project = await prisma.project.create({
          data: {
            ...request.body,
            createdAt: now,
            // Written with the job, as the two registers are: there is no
            // route that issues one afterwards and no state in which a
            // project has no address (issue #19).
            ingestToken: newIngestToken(),
            // Both correspondence logs, written with the job and never
            // afterwards (issue #14). Which types exist is a fact about the
            // product rather than a choice about a job, so there is no route
            // that creates one and no state in which a project has only one:
            // `@@unique([projectId, kind])` is what keeps that true.
            registers: {
              create: [
                { kind: 'SUBMITTAL', createdAt: now },
                { kind: 'RFI', createdAt: now },
              ],
            },
          },
        });
        return reply.code(201).send(projectOnTheWire(project, ingestDomain));
      } catch (error) {
        if (isUniqueViolation(error)) {
          return reply
            .code(409)
            .send({ message: 'that project number is already in use' });
        }
        throw error;
      }
    },
  );

  /**
   * Live projects by default; `?archived=true` for the finished ones, which
   * is how an archived record stays reachable without a memorised URL.
   *
   * Ordered by creation, not by project number: the plan fixes no order,
   * and sorting the number as text puts `T-10` above `T-2`.
   */
  v1.get<{ Querystring: { archived: boolean } }>(
    '/projects',
    { schema: { querystring: listQuerySchema } },
    async (request) =>
      (
        await prisma.project.findMany({
          where: request.query.archived
            ? { archivedAt: { not: null } }
            : { archivedAt: null },
          orderBy: { createdAt: 'asc' },
        })
      ).map((one) => projectOnTheWire(one, ingestDomain)),
  );

  /** Archived projects are readable here; only the list hides them. */
  v1.get<{ Params: { id: string } }>(
    '/projects/:id',
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
      });
      return project === null
        ? noSuchProject(reply)
        : projectOnTheWire(project, ingestDomain);
    },
  );

  /**
   * Archiving is one-way and stamped once. `updateMany` narrowed to the
   * unarchived row is what makes the second call a no-op rather than a
   * restamp — the date a job finished is a fact, not a last-touched time.
   */
  v1.post<{ Params: { id: string } }>(
    '/projects/:id/archive',
    async (request, reply) => {
      const { id } = request.params;
      await prisma.project.updateMany({
        where: { id, archivedAt: null },
        data: { archivedAt: timeSource.now() },
      });

      const project = await prisma.project.findUnique({ where: { id } });
      return project === null
        ? noSuchProject(reply)
        : projectOnTheWire(project, ingestDomain);
    },
  );

}
