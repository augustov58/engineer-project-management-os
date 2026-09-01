/** The project record: the row every other record hangs off (issue #3). */

import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  NOT_BLANK,
  type RouteDependencies,
  isUniqueViolation,
} from '../http.js';
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
 * Where this job's client-originated documents are read, and what the firm
 * signed to allow it (issue #21, stories 91 and 92).
 *
 * One route taking the setting's value, rather than two named actions the way
 * a reissue or a disposition is: those are events, and this is one column with
 * two values, so splitting it would put "exactly one of these holds" across
 * two handlers. The sign-off travels in the call that switches to cloud —
 * ADR-0026's shape, where what a change rests on is named in the call that
 * makes it rather than attached afterwards.
 *
 * Flat, with the pairing enforced in the handler and not by an ajv `if`/`then`:
 * no schema in this product carries a conditional, and the four refusals below
 * each say which of the four things went wrong, which one `oneOf` failure
 * could not.
 */
const processingLocationBodySchema = {
  type: 'object',
  required: ['location'],
  additionalProperties: false,
  properties: {
    location: { type: 'string', enum: ['LOCAL', 'CLOUD'] },
    signoffReference: { type: 'string', pattern: NOT_BLANK, maxLength: 200 },
    signoffAt: { type: 'string', format: 'date-time' },
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

  /**
   * Set where this job's documents are read (issue #21, stories 91 and 92).
   *
   * **Cloud is the default and this route is the only thing that gates it**,
   * which is the whole shape of ADR-0044's resolution. ADR-0013 rejected
   * local-first on operational grounds and is the qualifier ADR-0008 names, so
   * a project reaches `CLOUD` by being created — never having been switched,
   * and with no sign-off to show. The CHECK underneath can therefore only hold
   * the pairing, and "a switch to cloud carries a sign-off" is a rule the
   * boundary keeps alone. Under the glossary's rejected reading it would have
   * been a database fact, and saying so here is the price being visible.
   *
   * A second sign-off is refused rather than overwriting the first, as a
   * response, a disposition and a referenced-file marking all are — the record
   * of what the firm agreed to is not a last-write-wins field. Recording one
   * against a project still sitting at the default is *not* a second: it is the
   * first, which is the only way a default-cloud project ever gets one.
   *
   * Switching to local is always available and needs nothing, which is the one
   * asymmetry worth stating: consent can be withdrawn, and a route that could
   * refuse to stop sending documents would be the wrong refusal to own. It
   * clears the sign-off, so returning to cloud needs a fresh one — and what was
   * cleared survives in the audit entry, which is why that entry carries the
   * reference and the date rather than only naming the change.
   */
  v1.post<{
    Params: { id: string };
    Body: {
      location: 'LOCAL' | 'CLOUD';
      signoffReference?: string;
      signoffAt?: string;
    };
  }>(
    '/projects/:id/processing-location',
    { schema: { body: processingLocationBodySchema } },
    async (request, reply) => {
      const { id } = request.params;
      const { location, signoffReference, signoffAt } = request.body;

      const project = await prisma.project.findUnique({
        where: { id },
        select: { processingLocation: true, cloudSignoffReference: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }

      let data;
      if (location === 'CLOUD') {
        if (signoffReference === undefined || signoffAt === undefined) {
          return reply.code(400).send({
            message:
              'switching to cloud processing needs the written sign-off reference and its date',
          });
        }
        if (project.cloudSignoffReference !== null) {
          return reply.code(409).send({
            message: 'a written sign-off is already recorded on this project',
          });
        }
        data = {
          processingLocation: 'CLOUD',
          cloudSignoffReference: signoffReference,
          cloudSignoffAt: new Date(signoffAt),
        } as const;
      } else {
        if (signoffReference !== undefined || signoffAt !== undefined) {
          return reply
            .code(400)
            .send({ message: 'switching to local processing records no sign-off' });
        }
        if (project.processingLocation === 'LOCAL') {
          return reply
            .code(409)
            .send({ message: 'this project is already set to local processing' });
        }
        data = {
          processingLocation: 'LOCAL',
          cloudSignoffReference: null,
          cloudSignoffAt: null,
        } as const;
      }

      // The change and the audit of it in one statement, so no path exists on
      // which the setting moved and the log does not say so (ADR-0040's rule,
      // reaching a record other than memory for the first time — ADR-0044).
      const at = timeSource.now();
      const updated = await prisma.$transaction(async (tx) => {
        const written = await tx.project.update({ where: { id }, data });
        await tx.auditEntry.create({
          data: {
            projectId: id,
            action: `processing location set to ${location.toLowerCase()}`,
            detail:
              data.processingLocation === 'CLOUD'
                ? `the firm signed off in writing on ${data.cloudSignoffAt.toISOString()}, reference ${data.cloudSignoffReference}`
                : project.cloudSignoffReference === null
                  ? 'no sign-off had been recorded'
                  : `the recorded sign-off ${project.cloudSignoffReference} was cleared`,
            createdAt: at,
          },
        });
        return written;
      });

      return projectOnTheWire(updated, ingestDomain);
    },
  );

}
