/** Open items, and the one view that reads across every job (issue #4). */

import type { FastifyInstance } from 'fastify';
import { NOT_BLANK, type RouteDependencies, instant } from '../http.js';
import { noSuchOpenItem, noSuchProject } from '../refusals.js';

/**
 * Caps are chosen the way the project name's 200 was: the plan states none,
 * and an unbounded column is a way to wedge the record. The counterfactual
 * and the resolution note get more room, being prose about consequences
 * rather than a name or a phrase.
 */
export const openItemBodySchema = {
  type: 'object',
  required: ['unresolved', 'blocks', 'waitingOn', 'counterfactual'],
  additionalProperties: false,
  properties: {
    unresolved: { type: 'string', pattern: NOT_BLANK, maxLength: 500 },
    blocks: { type: 'string', pattern: NOT_BLANK, maxLength: 500 },
    // Null is nobody. A blank string is not — an empty field must never be a
    // way of saying that no one owes the next move (ADR-0014).
    waitingOn: { type: ['string', 'null'], pattern: NOT_BLANK, maxLength: 120 },
    // Optional so entry stays quick, and settable so a project's existing
    // items can be entered with the date they have actually been open since.
    waitingSince: { type: 'string', format: 'date-time' },
    invalidationTrigger: { type: 'string', pattern: NOT_BLANK, maxLength: 500 },
    counterfactual: { type: 'string', pattern: NOT_BLANK, maxLength: 1000 },
    owner: { type: 'string', pattern: NOT_BLANK, maxLength: 120 },
  },
} as const;

/**
 * The room an open item's `unresolved` has. Read off the schema rather than
 * written down twice, because a flag raised in its own words has to fit it.
 */
export const UNRESOLVED_MAX =
  openItemBodySchema.properties.unresolved.maxLength;

/** Resolving takes a note and a date; only the date may be left to the clock. */
export const resolveBodySchema = {
  type: 'object',
  required: ['note'],
  additionalProperties: false,
  properties: {
    note: { type: 'string', pattern: NOT_BLANK, maxLength: 1000 },
    resolvedAt: { type: 'string', format: 'date-time' },
  },
} as const;

/** Which half of one project's open items to list. */
const openItemListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { resolved: { type: 'boolean', default: false } },
} as const;

/**
 * The pending items view. Unresolved is not a parameter: an item that is
 * resolved is not pending, which is the whole definition of the view.
 */
const pendingQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    waitingOn: { type: 'string', pattern: NOT_BLANK, maxLength: 120 },
    sort: { type: 'string', enum: ['oldest', 'newest'], default: 'oldest' },
  },
} as const;

/**
 * The reserved filter value for "no one owes the next move". Matched without
 * regard to case, because the screens render it as "Nobody" and typing back
 * what the screen shows must not silently become a search for a party of that
 * name. A blank `waitingOn=` is rejected instead, so a blank filter and this
 * one never collapse into each other.
 */
const NOBODY = 'nobody';

function meansNobody(waitingOn: string): boolean {
  return waitingOn.toLowerCase() === NOBODY;
}

export function openItemRoutes(
  v1: FastifyInstance,
  { prisma, timeSource }: RouteDependencies,
): void {
  /**
   * An open item is attached to a subject, not owned by one: the column
   * pair is polymorphic, so there is no foreign key and the subject is
   * checked here instead.
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
    '/projects/:id/open-items',
    { schema: { body: openItemBodySchema } },
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }

      const { waitingSince, ...rest } = request.body;
      const item = await prisma.openItem.create({
        data: {
          ...rest,
          subjectType: 'PROJECT',
          subjectId: project.id,
          waitingSince: instant(waitingSince, timeSource),
        },
      });
      return reply.code(201).send(item);
    },
  );

  /**
   * One project's open items. Unresolved by default; `?resolved=true` is
   * how a resolved item stays visible on the artifact it was attached to,
   * rather than disappearing the moment it is answered.
   */
  v1.get<{ Params: { id: string }; Querystring: { resolved: boolean } }>(
    '/projects/:id/open-items',
    { schema: { querystring: openItemListQuerySchema } },
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }

      return prisma.openItem.findMany({
        where: {
          subjectType: 'PROJECT',
          subjectId: project.id,
          resolvedAt: request.query.resolved ? { not: null } : null,
        },
        orderBy: { waitingSince: 'asc' },
      });
    },
  );

  /**
   * The pending items view: every unresolved open item across every
   * project, oldest first, because the age is the reason to look at it.
   *
   * Archived projects are included. The glossary drops them from the live
   * project list and from the daily counts, neither of which this is —
   * and an unresolved item on a finished job is exactly the thing that
   * would otherwise be lost.
   */
  v1.get<{ Querystring: { waitingOn?: string; sort: 'oldest' | 'newest' } }>(
    '/open-items',
    { schema: { querystring: pendingQuerySchema } },
    async (request) => {
      const { waitingOn, sort } = request.query;

      const items = await prisma.openItem.findMany({
        where: {
          resolvedAt: null,
          ...(waitingOn === undefined
            ? {}
            : { waitingOn: meansNobody(waitingOn) ? null : waitingOn }),
        },
        orderBy: { waitingSince: sort === 'newest' ? 'desc' : 'asc' },
      });

      // A polymorphic subject cannot be joined, and the view is unusable
      // without knowing which job each item is on — so the subjects are
      // fetched once and attached.
      const projects = await prisma.project.findMany({
        where: { id: { in: items.map((item) => item.subjectId) } },
        select: { id: true, projectNumber: true, name: true },
      });
      const byId = new Map(projects.map((p) => [p.id, p]));

      return items.map((item) => ({
        ...item,
        project: byId.get(item.subjectId) ?? null,
      }));
    },
  );

  /**
   * Resolving is refused rather than repeated. A second resolve would
   * otherwise overwrite the first note silently, and the reason an item
   * was closed is the part worth keeping.
   */
  v1.post<{ Params: { id: string }; Body: { note: string; resolvedAt?: string } }>(
    '/open-items/:id/resolve',
    { schema: { body: resolveBodySchema } },
    async (request, reply) => {
      const { id } = request.params;
      const item = await prisma.openItem.findUnique({ where: { id } });
      if (item === null) {
        return noSuchOpenItem(reply);
      }
      if (item.resolvedAt !== null) {
        return reply
          .code(409)
          .send({ message: 'that open item is already resolved' });
      }

      return prisma.openItem.update({
        where: { id },
        data: {
          resolutionNote: request.body.note,
          resolvedAt: instant(request.body.resolvedAt, timeSource),
        },
      });
    },
  );

  /** For the item whose answer turned out to be wrong. */
  v1.post<{ Params: { id: string } }>(
    '/open-items/:id/reopen',
    async (request, reply) => {
      const { id } = request.params;
      const item = await prisma.openItem.findUnique({ where: { id } });
      if (item === null) {
        return noSuchOpenItem(reply);
      }
      if (item.resolvedAt === null) {
        return reply
          .code(409)
          .send({ message: 'that open item is not resolved' });
      }

      return prisma.openItem.update({
        where: { id },
        data: { resolvedAt: null, resolutionNote: null },
      });
    },
  );

}
