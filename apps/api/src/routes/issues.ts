/** Issues: findings carrying an identifier the job never reuses (issue #10). */

import type { FastifyInstance } from 'fastify';
import { type PrismaClient } from '../../generated/prisma/client.js';
import type { TimeSource } from '../time-source.js';
import {
  NOT_BLANK,
  type RouteDependencies,
  instant,
  isUniqueViolation,
  violates,
} from '../http.js';
import {
  type Refusal,
  noSuchIssue,
  noSuchObservation,
  noSuchProject,
  openItemRefusal,
  refuse,
} from '../refusals.js';
import { openItemBodySchema, resolveBodySchema } from './open-items.js';
import { issueInclude, withSightings } from '../wire.js';

/**
 * The closed set of exactly five, in the words the glossary writes them
 * (story 60).
 *
 * The strings themselves, and not a code-shaped spelling of them: these are
 * what an engineer picks off a list and what a report prints, so the value
 * stored, the value on the wire and the value on the screen are one string
 * playing all three parts. A `PHYSICAL_SAFETY` would need the real words in a
 * lookup beside it here and again in the frontend — the second place the same
 * fact lives that ADR-0024 refuses.
 *
 * Refused here at the boundary and again by a CHECK constraint in the
 * migration, which is the double enforcement ADR-0030 gave the one-axis rule
 * and what the spec means by "enforce them in the schema, not only in the
 * interface".
 */
const ISSUE_CATEGORIES = [
  'Accessibility',
  'Physical / Safety',
  'Functional',
  'Safety / Code',
  'Design / Coordination',
] as const;

/**
 * The set is closed in the type as well as in the schema and the CHECK, so a
 * sixth cannot be written into a route by hand and reach the database to be
 * refused there.
 */
type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

/**
 * Raising a finding. The category and nothing else: what was seen, when and
 * where is already the observation's, and the identifier is allocated here
 * rather than supplied — a caller that could name its own number could reuse
 * one, which is the whole of what story 59 forbids.
 */
const issueBodySchema = {
  type: 'object',
  required: ['category'],
  additionalProperties: false,
  properties: { category: { type: 'string', enum: ISSUE_CATEGORIES } },
} as const;

/**
 * Closing takes a note and a date; only the date may be left to the clock.
 * The cap is read off the open item's resolution note rather than written down
 * twice, being the same field on the other record with a lifecycle.
 */
const closeIssueBodySchema = {
  type: 'object',
  required: ['note'],
  additionalProperties: false,
  properties: {
    note: {
      type: 'string',
      pattern: NOT_BLANK,
      maxLength: resolveBodySchema.properties.note.maxLength,
    },
    closedAt: { type: 'string', format: 'date-time' },
  },
} as const;

/**
 * The stable identifier in a path. Declared as an integer so that a number
 * that is not one is a 400 from the schema rather than a lookup that quietly
 * finds nothing.
 */
const issueNumberParamsSchema = {
  type: 'object',
  required: ['id', 'number'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    number: { type: 'integer', minimum: 1 },
  },
} as const;

/**
 * Why an observation named in a request cannot be used on this finding.
 *
 * The project is the visit's, read through it, because an observation is bound
 * to the walk that produced it and to nothing else (ADR-0030).
 */
async function observationRefusal(
  prisma: PrismaClient,
  observationId: string,
  projectId: string,
): Promise<Refusal | null> {
  const observation = await prisma.observation.findUnique({
    where: { id: observationId },
    select: { siteVisit: { select: { projectId: true } } },
  });
  if (observation === null) {
    return { code: 404, message: 'no observation with that id' };
  }
  if (observation.siteVisit.projectId !== projectId) {
    return { code: 409, message: 'that observation is on another project' };
  }
  return null;
}

/**
 * Raising a finding from a sighting (story 57).
 *
 * One transaction, so the identifier and the row that spends it are written
 * together — and so a refused promotion gives the number back, which is the
 * only moment one ever can be given back. A double tap that promoted twice
 * would otherwise burn an identifier on a duplicate and leave the register
 * permanently one issue heavier.
 */
function writeIssue(
  prisma: PrismaClient,
  timeSource: TimeSource,
  observation: { id: string; projectId: string },
  category: IssueCategory,
) {
  return prisma.$transaction(async (tx) => {
    // The high-water mark, and never `MAX(number) + 1`: this only ever
    // increases, so a number is handed out once and never again — not after a
    // close and not after a deletion (story 59). The increment takes the
    // project's row lock, so two promotions at once serialise rather than
    // race, and `@@unique([projectId, number])` is what holds the rule.
    const { issuesAllocated } = await tx.project.update({
      where: { id: observation.projectId },
      data: { issuesAllocated: { increment: 1 } },
      select: { issuesAllocated: true },
    });

    return tx.issue.create({
      data: {
        projectId: observation.projectId,
        number: issuesAllocated,
        category,
        createdAt: timeSource.now(),
        observations: { create: { observationId: observation.id } },
      },
      include: issueInclude,
    });
  });
}

export function issueRoutes(
  v1: FastifyInstance,
  { prisma, timeSource }: RouteDependencies,
): void {
  /**
   * A sighting becomes a finding (story 57).
   *
   * The route names no verb: the vault's word for the transition is
   * *become* and the spec's is *promote*, and `.../observations/:id/issue`
   * is neither, in the shape `.../flags/:line/open-item` already has for
   * exactly this cardinality — one entry, at most one record.
   *
   * Nothing is written to the observation. Becoming an issue is a row
   * pointing at it (ADR-0030), so the majority case that never becomes one
   * carries no trace of the exception.
   */
  v1.post<{ Params: { id: string }; Body: { category: IssueCategory } }>(
    '/observations/:id/issue',
    { schema: { body: issueBodySchema } },
    async (request, reply) => {
      const observation = await prisma.observation.findUnique({
        where: { id: request.params.id },
        select: { id: true, siteVisit: { select: { projectId: true } } },
      });
      if (observation === null) {
        return noSuchObservation(reply);
      }

      try {
        const raised = await writeIssue(
          prisma,
          timeSource,
          { id: observation.id, projectId: observation.siteVisit.projectId },
          request.body.category,
        );
        return reply.code(201).send(withSightings(raised));
      } catch (error) {
        // Narrowed to the sighting's own constraint. The transaction also
        // writes `issues`, whose unique index is on the project and the
        // number, and answering "already an issue" to that collision would
        // be a lie at the one moment anybody read it.
        if (violates(error, 'observation_id')) {
          return reply
            .code(409)
            .send({ message: 'that observation is already an issue' });
        }
        throw error;
      }
    },
  );

  /**
   * A project's findings, by identifier, with their state across every
   * walk they were seen on.
   *
   * Closed issues are listed with the open ones. The lifecycle is the
   * point of the record — a register that hid what had closed would be the
   * write-up with no follow-up all over again.
   */
  v1.get<{ Params: { id: string } }>(
    '/projects/:id/issues',
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }

      const listed = await prisma.issue.findMany({
        where: { projectId: project.id },
        orderBy: { number: 'asc' },
        include: issueInclude,
      });
      return listed.map(withSightings);
    },
  );

  /**
   * Resolving the stable identifier, which is what having one is for
   * (story 58): a reference printed in an issued report, or written into a
   * photograph's filename, is looked up here.
   *
   * Addressed by the project and the number rather than by the row's id,
   * because the number is the identifier and the uuid is not the thing
   * anybody has written down.
   */
  v1.get<{ Params: { id: string; number: number } }>(
    '/projects/:id/issues/:number',
    { schema: { params: issueNumberParamsSchema } },
    async (request, reply) => {
      const { id, number } = request.params;
      const found = await prisma.issue.findUnique({
        where: { projectId_number: { projectId: id, number } },
        include: issueInclude,
      });
      // One message for a job that has no such issue and for a job that
      // does not exist: numbering restarts per project, so "issue 1" is
      // only ever an answer with a job beside it either way.
      if (found === null) {
        return reply
          .code(404)
          .send({ message: 'no issue with that number on this project' });
      }
      return withSightings(found);
    },
  );

  /**
   * Still there on the second walk (story 61). A later visit's observation
   * joins the finding it is another sighting of, and the issue's own
   * identifier is untouched — which is the whole point of it surviving the
   * report it first appeared in.
   *
   * There is no state transition here and none to record: the sightings
   * *are* the history, which is why the issue keeps no per-visit status.
   */
  v1.post<{ Params: { id: string; observationId: string } }>(
    '/issues/:id/observations/:observationId',
    async (request, reply) => {
      const { id, observationId } = request.params;
      const found = await prisma.issue.findUnique({
        where: { id },
        select: { id: true, projectId: true },
      });
      if (found === null) {
        return noSuchIssue(reply);
      }

      const bad = await observationRefusal(
        prisma,
        observationId,
        found.projectId,
      );
      if (bad !== null) {
        return refuse(reply, bad);
      }

      // Both are refusals, and which one it is says where to look: the
      // second half of a double tap, or a sighting that belongs to a
      // different finding entirely.
      const already = await prisma.issueObservation.findUnique({
        where: { observationId },
        select: { issueId: true },
      });
      if (already !== null) {
        return reply.code(409).send({
          message:
            already.issueId === id
              ? 'that observation is already on this issue'
              : 'that observation is already on another issue',
        });
      }

      try {
        await prisma.issueObservation.create({
          data: { issueId: id, observationId },
        });
      } catch (error) {
        // The lookup above answers the ordinary case; this is the race,
        // and the unique index is what actually holds the rule.
        if (isUniqueViolation(error)) {
          return reply.code(409).send({
            message: 'that observation is already on another issue',
          });
        }
        throw error;
      }
      return reply.code(204).send();
    },
  );

  /**
   * The lifecycle the five findings of 2026-07-23 never had (story 62):
   * closed with a date and the note that closed it.
   *
   * Refused rather than repeated, matching resolve: a second closing
   * carries a note that would silently overwrite the first, and the reason
   * a finding was closed is the part worth keeping.
   */
  v1.post<{
    Params: { id: string };
    Body: { note: string; closedAt?: string };
  }>(
    '/issues/:id/close',
    { schema: { body: closeIssueBodySchema } },
    async (request, reply) => {
      const found = await prisma.issue.findUnique({
        where: { id: request.params.id },
        select: { id: true, closedAt: true },
      });
      if (found === null) {
        return noSuchIssue(reply);
      }
      if (found.closedAt !== null) {
        return reply
          .code(409)
          .send({ message: 'that issue is already closed' });
      }

      const closed = await prisma.issue.update({
        where: { id: found.id },
        data: {
          closedAt: instant(request.body.closedAt, timeSource),
          closureNote: request.body.note,
        },
        include: issueInclude,
      });
      return withSightings(closed);
    },
  );

  /**
   * For the finding that recurs. Clears both columns together, because
   * they are one fact in two halves and a closing note left standing on an
   * open issue would say it had been dealt with (ADR-0024's shape).
   */
  v1.post<{ Params: { id: string } }>(
    '/issues/:id/reopen',
    async (request, reply) => {
      const found = await prisma.issue.findUnique({
        where: { id: request.params.id },
        select: { id: true, closedAt: true },
      });
      if (found === null) {
        return noSuchIssue(reply);
      }
      if (found.closedAt === null) {
        return reply
          .code(409)
          .send({ message: 'that issue is not closed' });
      }

      const reopened = await prisma.issue.update({
        where: { id: found.id },
        data: { closedAt: null, closureNote: null },
        include: issueInclude,
      });
      return withSightings(reopened);
    },
  );

  /**
   * An open item raised on a finding (story 69): a finding blocked on
   * someone else's answer shows up in the same pending items view as
   * everything else.
   *
   * Its subject is the **project**, not the issue. ADR-0030 expected this
   * to need a second value in `OpenItemSubject`; it does not, and should
   * not have one — ADR-0026 already recorded what the subject reading
   * costs, which is that the item vanishes from the project screen and
   * reaches the pending items view with no job beside it. The join says
   * which finding it is being chased for; the subject says where it lives.
   */
  v1.post<{
    Params: { id: string };
    Body: {
      unresolved: string;
      blocks: string;
      waitingOn: string | null;
      waitingSince?: string;
      invalidationTrigger?: string;
      counterfactual: string;
      owner?: string;
    };
  }>(
    '/issues/:id/open-items',
    { schema: { body: openItemBodySchema } },
    async (request, reply) => {
      const found = await prisma.issue.findUnique({
        where: { id: request.params.id },
        select: { id: true, projectId: true },
      });
      if (found === null) {
        return noSuchIssue(reply);
      }

      const { waitingSince, ...rest } = request.body;
      const item = await prisma.openItem.create({
        data: {
          ...rest,
          subjectType: 'PROJECT',
          subjectId: found.projectId,
          waitingSince: instant(waitingSince, timeSource),
          issues: { create: { issueId: found.id } },
        },
      });
      return reply.code(201).send(item);
    },
  );

  /**
   * Attaching an item already on the job, for the one raised before anyone
   * knew which finding it was about. Refused rather than repeated, matching
   * the submission's attach.
   */
  v1.post<{ Params: { id: string; openItemId: string } }>(
    '/issues/:id/open-items/:openItemId',
    async (request, reply) => {
      const { id, openItemId } = request.params;
      const found = await prisma.issue.findUnique({
        where: { id },
        select: { id: true, projectId: true },
      });
      if (found === null) {
        return noSuchIssue(reply);
      }

      const badItem = await openItemRefusal(
        prisma,
        openItemId,
        found.projectId,
      );
      if (badItem !== null) {
        return refuse(reply, badItem);
      }

      try {
        await prisma.issueOpenItem.create({
          data: { issueId: found.id, openItemId },
        });
      } catch (error) {
        // Unqualified, and safe to be: the composite key is the only
        // constraint this insert can hit.
        if (isUniqueViolation(error)) {
          return reply
            .code(409)
            .send({ message: 'that open item is already on this issue' });
        }
        throw error;
      }
      return reply.code(204).send();
    },
  );

  // ── Photographs and the two bindings (issue #11) ─────────────────────

}
