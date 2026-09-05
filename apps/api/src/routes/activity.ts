/**
 * The activity feed: what happened on this job lately (story 107, ADR-0048).
 *
 * A **read over `audit_entries`** and not a second stream. Story 107 asks for a
 * feed "distinct from the audit record, so that 'what happened on this project
 * lately' and 'what is the compliance history' are different questions with
 * different answers" — and the answers differ here in their **order** and their
 * **bound**, not in the rows they are drawn from. The PRD sketch's
 * `activity_events` table is refused: a second stream is a second place the
 * same fact lives, with its own sixty-two writers, and a drift between them
 * would put the version nobody checks in front of the engineer and the version
 * nobody reads in front of the dispute.
 *
 * Named for the glossary's **Activity event** and matching
 * `test/activity.test.ts`, which is ADR-0033's rule. `src/audit.ts` keeps its
 * own name: it is the leaf every route *writes* a line through, and this is a
 * reader of them.
 *
 * `GET /v1/projects/:id/memory/audit` is untouched and still answers the other
 * question — every line, oldest first, unbounded.
 */

import type { FastifyInstance } from 'fastify';
import type { RouteDependencies } from '../http.js';
import { noSuchProject } from '../refusals.js';

/**
 * What "lately" is, before anybody asks for more.
 *
 * About a week of ordinary work on a live job. A judgement and not a
 * measurement — it is what a screen shows first, and moving it changes nothing
 * about the record.
 */
const LATELY = 50;

/**
 * The furthest the feed may be widened, and it is **load-bearing**.
 *
 * Without a maximum this route is the compliance record with a query parameter
 * on it, and story 107's two questions collapse back into one. With it, asking
 * for all of it means going to the audit read, which is where all of it lives
 * (ADR-0048).
 */
const MOST = 200;

const activityQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: MOST, default: LATELY },
  },
} as const;

export function activityRoutes(
  v1: FastifyInstance,
  { prisma }: RouteDependencies,
): void {
  /**
   * This job's activity, newest first.
   *
   * The **exact reverse** of the audit read's order, over the same total order
   * — `created_at` then `id`, reversed in both keys — so the two answers can
   * never disagree about what happened while differing about how it is read. A
   * test asserts that the one is the other reversed, which is the guarantee a
   * second stream could not offer at all.
   *
   * A job's feed is never empty: recording the job writes the first line of its
   * own audit (story 106), so "nothing has happened here" is not a state this
   * route can be in for a project that exists.
   *
   * The response is a list and its **length is not a count**. Exposure and the
   * clock are lists whose length is the count (ADR-0027, ADR-0037); this one is
   * bounded, so its length is the bound or less, and a screen rendering it as a
   * number would say "37 things happened" where the truth is "at least 37, and
   * 50 was what was asked for". ADR-0016 keeps this product to two daily
   * figures and this is not a third.
   *
   * Project-scoped and deliberately not offered across every job, for the
   * reason `GET /projects/:id/extraction-targets` is not (ADR-0039): a third
   * across-every-project figure is what ADR-0016 exists to keep out.
   */
  v1.get<{ Params: { id: string }; Querystring: { limit: number } }>(
    '/projects/:id/activity',
    { schema: { querystring: activityQuerySchema } },
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }

      // The same five fields the audit read returns, because they are the same
      // rows. A feed-specific shape would be a second rendering of one fact,
      // free to fall behind the audit's (ADR-0048).
      return prisma.auditEntry.findMany({
        where: { projectId: project.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: request.query.limit,
      });
    },
  );
}
