/**
 * Submissions: what went out, what it rested on, and what replaced it.
 *
 * Issues #5 through #7 in one file because they are one record. Nothing here
 * updates a submission (ADR-0015): a correction is a reissue, which writes a
 * new row and nothing at all to the one it replaces (ADR-0028).
 */

import type { FastifyInstance } from 'fastify';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
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
  alreadySuperseded,
  noSuchProject,
  noSuchSubmission,
  openItemRefusal,
  phaseRefusal,
  refuse,
} from '../refusals.js';
import { openItemBodySchema } from './open-items.js';

/**
 * What went out, to whom, when, and at what phase, as one record (issue #5).
 *
 * `issuedProvisional` is deliberately absent: it is stamped here from the open
 * items named right then, and a caller that could assert it would be able to
 * claim a set went out clean when it did not. `additionalProperties: false`
 * is what refuses the attempt.
 *
 * The phase may be left off, in which case the project's current phase is
 * used. Caps follow the open item's: 120 for a party, 32 for a revision an
 * engineer writes by hand, and 2000 for the sheet list, which is the one
 * field here that holds a list rather than a phrase.
 */
const submissionBodySchema = {
  type: 'object',
  required: ['recipient', 'recipientRole', 'revision', 'sheetList'],
  additionalProperties: false,
  properties: {
    phaseId: { type: 'string' },
    issuedAt: { type: 'string', format: 'date-time' },
    recipient: { type: 'string', pattern: NOT_BLANK, maxLength: 120 },
    recipientRole: { type: 'string', pattern: NOT_BLANK, maxLength: 120 },
    revision: { type: 'string', pattern: NOT_BLANK, maxLength: 32 },
    sheetList: { type: 'string', pattern: NOT_BLANK, maxLength: 2000 },
    // What the set rests on, named while recording it. Issue #6 stamps
    // whether the submission went out on unconfirmed inputs at the moment of
    // issuance and never recomputes it, so there has to be a moment at which
    // both the row and what it rests on exist together. Attaching afterwards
    // stays available; it is the correction, not the entry path.
    openItemIds: { type: 'array', items: { type: 'string' }, maxItems: 100 },
  },
} as const;

/** Which project's exposure, or every live one's. */
const exposureQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { projectId: { type: 'string' } },
} as const;

/**
 * The relations the facts stored nowhere are read from: what a submission
 * rests on, and whether anything has replaced it. Selected rather than
 * included, so a list read does not drag whole records across for two
 * booleans.
 */
const derivedState = {
  openItems: { select: { openItem: { select: { resolvedAt: true } } } },
  supersededBy: { select: { id: true } },
} as const;

/**
 * *Currently provisional*: true exactly when something the set rests on is
 * unresolved right now (ADR-0024's one column, read live).
 *
 * Derived on every read and stored nowhere. `issued_provisional` is the other
 * fact — that the set went out on unconfirmed inputs — and one column could
 * not be both: it would have to start lying about one of them the moment an
 * item resolved.
 */
function isCurrentlyProvisional(
  openItems: { openItem: { resolvedAt: Date | null } }[],
): boolean {
  return openItems.some((row) => row.openItem.resolvedAt === null);
}

/**
 * A submission on the wire carries both provisional facts, never one merged
 * into the other, and says whether it has been superseded.
 *
 * *Superseded* is a successor existing, derived here on every read. Storing it
 * would be the edit to the prior row that ADR-0015 forbids — the row a reissue
 * points at is never written to again (ADR-0026).
 */
function withDerivedState<
  T extends {
    openItems: { openItem: { resolvedAt: Date | null } }[];
    supersededBy: { id: string } | null;
  },
>(
  found: T,
): Omit<T, 'openItems' | 'supersededBy'> & {
  currentlyProvisional: boolean;
  supersededById: string | null;
} {
  const { openItems, supersededBy, ...submission } = found;
  return {
    ...submission,
    currentlyProvisional: isCurrentlyProvisional(openItems),
    supersededById: supersededBy === null ? null : supersededBy.id,
  };
}

/**
 * A submission the instant it was recorded. The two provisional facts
 * coincide at issuance, which is the only moment they ever have to, and
 * nothing can already point at a row created a moment ago.
 */
function asRecorded<T extends { issuedProvisional: boolean }>(submission: T) {
  return {
    ...submission,
    currentlyProvisional: submission.issuedProvisional,
    supersededById: null,
  };
}

/**
 * Enough of each link to tell the sets in a lineage apart on a screen. The
 * caller already holds the row it is asking about, so the walk is given it
 * rather than fetching it a second time.
 */
const chainSelect = {
  id: true,
  revision: true,
  issuedAt: true,
  recipient: true,
  recipientRole: true,
  issuedProvisional: true,
  supersedesId: true,
} as const;

type ChainLink = Prisma.SubmissionGetPayload<{ select: typeof chainSelect }>;

/**
 * The whole lineage a submission sits in, oldest issuance first, with the
 * current one marked (issue #7). Read from any link and it is the same list:
 * this is how "what is the current issuance of this?" is answered without
 * reading email.
 *
 * Walked a row at a time rather than in one recursive query. A chain is a
 * handful of issuances, and it terminates by construction — `supersedes_id`
 * is written once, pointing at a row that already existed, and no route ever
 * repoints it, so the links cannot form a cycle.
 */
async function supersedeChain(prisma: PrismaClient, found: ChainLink) {
  const chain: ChainLink[] = [found];

  // Back to the first issuance, by the column each successor carries.
  let older: string | null = found.supersedesId;
  while (older !== null) {
    const previous = await prisma.submission.findUnique({
      where: { id: older },
      select: chainSelect,
    });
    // A foreign key with nothing deleting submissions, so this is unreachable.
    if (previous === null) {
      break;
    }
    chain.unshift(previous);
    older = previous.supersedesId;
  }

  // Forward to the current one, by the unique back-reference — which is what
  // makes the chain linear: at most one row can name any given predecessor.
  let newer = found.id;
  for (;;) {
    const next = await prisma.submission.findUnique({
      where: { supersedesId: newer },
      select: chainSelect,
    });
    if (next === null) {
      break;
    }
    chain.push(next);
    newer = next.id;
  }

  return chain.map((entry, index) => ({
    ...entry,
    current: index === chain.length - 1,
  }));
}

/**
 * A submission about to be recorded, whichever route is recording it. Named
 * for the record and not for the act: "issuance" is the moment, and this is
 * the thing that goes into the table.
 */
interface NewSubmission {
  projectId: string;
  phaseId: string;
  issuedAt?: string;
  recipient: string;
  recipientRole: string;
  revision: string;
  sheetList: string;
  openItemIds: string[];
  /** The submission this one replaces, or null when it replaces nothing. */
  supersedesId: string | null;
}

/** The checks a submission goes through before anything is written. */
async function issuanceRefusal(
  prisma: PrismaClient,
  { projectId, phaseId, openItemIds }: NewSubmission,
): Promise<Refusal | null> {
  const badPhase = await phaseRefusal(prisma, phaseId, projectId);
  if (badPhase !== null) {
    return badPhase;
  }

  if (new Set(openItemIds).size !== openItemIds.length) {
    return {
      code: 409,
      message: 'an open item can only be named once on a submission',
    };
  }
  for (const openItemId of openItemIds) {
    const badItem = await openItemRefusal(prisma, openItemId, projectId);
    if (badItem !== null) {
      return badItem;
    }
  }
  return null;
}

/**
 * One transaction, so a submission never exists having lost the record of
 * what it rests on — and so the snapshot is taken at the same instant as the
 * row. The open items are re-read inside it rather than reused from the
 * checks above: a resolve landing in between would otherwise be stamped into
 * history as though it had happened first.
 */
function writeIssuance(
  prisma: PrismaClient,
  timeSource: TimeSource,
  { openItemIds, issuedAt, ...row }: NewSubmission,
) {
  return prisma.$transaction(async (tx) => {
    const named = await tx.openItem.findMany({
      where: { id: { in: openItemIds } },
      select: { id: true, resolvedAt: true },
    });
    const unresolvedThen = new Map(
      named.map((item) => [item.id, item.resolvedAt === null]),
    );

    const created = await tx.submission.create({
      data: {
        ...row,
        issuedAt: instant(issuedAt, timeSource),
        createdAt: timeSource.now(),
        // The permanent fact that the set went out on unconfirmed inputs.
        // Nothing recomputes it afterwards, and a reissue stamps its own
        // rather than copying the one it supersedes.
        issuedProvisional: named.some((item) => item.resolvedAt === null),
      },
    });
    if (openItemIds.length > 0) {
      await tx.submissionOpenItem.createMany({
        data: openItemIds.map((openItemId) => ({
          submissionId: created.id,
          openItemId,
          // Every id was checked to exist above; the fallback is unreachable
          // and here so an `undefined` can never land as the null that means
          // "attached afterwards".
          unresolvedAtIssuance: unresolvedThen.get(openItemId) ?? false,
        })),
      });
    }
    return created;
  });
}

/**
 * The row an open item raised against an issuance becomes, wherever it is
 * raised from — by hand on the submission screen, or from a `FLAGS / VERIFY`
 * entry (issue #8).
 *
 * Its subject is the **project**, not the submission: an item that vanished
 * from the project screen the moment it was tied to a set would be the
 * opposite of "nothing sitting in my court" (ADR-0026). The join row is what
 * says which issuance rests on it.
 *
 * `unresolved` is passed rather than read out of the body, because a flag
 * supplies its own when the caller leaves it off.
 */
export function itemOnSubmission(
  body: {
    blocks: string;
    waitingOn: string | null;
    waitingSince?: string;
    invalidationTrigger?: string;
    counterfactual: string;
    owner?: string;
  },
  submission: { id: string; projectId: string },
  unresolved: string,
  timeSource: TimeSource,
) {
  const { waitingSince, ...rest } = body;
  return {
    ...rest,
    unresolved,
    subjectType: 'PROJECT',
    subjectId: submission.projectId,
    waitingSince: instant(waitingSince, timeSource),
    submissions: { create: { submissionId: submission.id } },
  } satisfies Prisma.OpenItemCreateInput | Prisma.OpenItemUncheckedCreateInput;
}

export function submissionRoutes(
  v1: FastifyInstance,
  { prisma, timeSource }: RouteDependencies,
): void {
  /**
   * Recording an issuance. There is no draft state and no route that
   * edits one afterwards: a correction is a reissue that supersedes
   * (ADR-0015), which is issue #7.
   */
  v1.post<{
    Params: { id: string };
    Body: {
      phaseId?: string;
      issuedAt?: string;
      recipient: string;
      recipientRole: string;
      revision: string;
      sheetList: string;
      openItemIds?: string[];
    };
  }>(
    '/projects/:id/submissions',
    { schema: { body: submissionBodySchema } },
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: { id: true, currentPhaseId: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }

      const { phaseId, issuedAt, openItemIds = [], ...rest } = request.body;
      const wanted = phaseId ?? project.currentPhaseId;
      if (wanted === null || wanted === undefined) {
        return reply.code(409).send({
          message: 'this project has no phase to issue at yet',
        });
      }

      const toIssue: NewSubmission = {
        ...rest,
        projectId: project.id,
        phaseId: wanted,
        issuedAt,
        openItemIds,
        // A first issuance replaces nothing. Correcting one is the
        // reissue route below, never a second create.
        supersedesId: null,
      };

      const bad = await issuanceRefusal(prisma, toIssue);
      if (bad !== null) {
        return refuse(reply, bad);
      }

      const submission = await writeIssuance(prisma, timeSource, toIssue);
      return reply.code(201).send(asRecorded(submission));
    },
  );

  /**
   * Reissue: correcting or reconsidering an issuance is a *new*
   * submission that points at the one it replaces (ADR-0015, issue #7).
   *
   * Nothing about the predecessor is written. It stays exactly as it went
   * out, and *superseded* is this row existing — derived on every read,
   * because storing it would be the edit to the prior row that the whole
   * decision forbids.
   */
  v1.post<{
    Params: { id: string };
    Body: {
      phaseId?: string;
      issuedAt?: string;
      recipient: string;
      recipientRole: string;
      revision: string;
      sheetList: string;
      openItemIds?: string[];
    };
  }>(
    '/submissions/:id/reissue',
    { schema: { body: submissionBodySchema } },
    async (request, reply) => {
      const superseded = await prisma.submission.findUnique({
        where: { id: request.params.id },
        select: {
          id: true,
          projectId: true,
          phaseId: true,
          supersededBy: { select: { id: true } },
          openItems: { select: { openItemId: true } },
        },
      });
      if (superseded === null) {
        return noSuchSubmission(reply);
      }
      // The unique index says this too, and says it under a race. Asked
      // here so the ordinary answer is the sentence rather than a 500.
      if (superseded.supersededBy !== null) {
        return alreadySuperseded(reply);
      }

      const { phaseId, issuedAt, openItemIds, ...rest } = request.body;
      const toIssue: NewSubmission = {
        ...rest,
        projectId: superseded.projectId,
        // Another issuance of the same set, at the same stage unless the
        // reissue says otherwise. Defaulting to the project's current
        // phase would quietly move a correction to wherever the job has
        // got to since.
        phaseId: phaseId ?? superseded.phaseId,
        issuedAt,
        // Left off entirely, what the superseded set rested on carries
        // forward — a reissue must never silently lose the dependencies
        // the original stood on. A supplied list is exactly that list,
        // which is how one is dropped before committing, so `[]` is a
        // deliberate drop rather than an omission.
        openItemIds:
          openItemIds ?? superseded.openItems.map((row) => row.openItemId),
        supersedesId: superseded.id,
      };

      const bad = await issuanceRefusal(prisma, toIssue);
      if (bad !== null) {
        return refuse(reply, bad);
      }

      try {
        const reissued = await writeIssuance(prisma, timeSource, toIssue);
        return reply.code(201).send(asRecorded(reissued));
      } catch (error) {
        // Narrowed to the supersede column: anything else colliding here
        // is a state this route does not understand, and a 500 is the
        // honest answer to it.
        if (violates(error, 'supersedes_id')) {
          return alreadySuperseded(reply);
        }
        throw error;
      }
    },
  );

  /**
   * Issuance order, oldest first: this is a chronicle of what went out.
   * Entry order breaks a tie, so two sets issued on the same day do not
   * come back in an arbitrary one.
   */
  v1.get<{ Params: { id: string } }>(
    '/projects/:id/submissions',
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }

      const listed = await prisma.submission.findMany({
        where: { projectId: project.id },
        orderBy: [{ issuedAt: 'asc' }, { createdAt: 'asc' }],
        include: derivedState,
      });
      return listed.map(withDerivedState);
    },
  );

  /**
   * One submission, with the phase it was issued at, the job it belongs
   * to, and what it rests on. The open items come through the join rather
   * than through their subject, which is what lets one item back several
   * issuances and lets a resolved one stay on the set it went out with
   * (ADR-0026).
   */
  v1.get<{ Params: { id: string } }>(
    '/submissions/:id',
    async (request, reply) => {
      const found = await prisma.submission.findUnique({
        where: { id: request.params.id },
        include: {
          phase: true,
          project: {
            select: { id: true, projectNumber: true, name: true },
          },
          supersededBy: { select: { id: true } },
          openItems: {
            include: { openItem: true },
            orderBy: { openItem: { waitingSince: 'asc' } },
          },
        },
      });
      if (found === null) {
        return noSuchSubmission(reply);
      }

      const { openItems, supersededBy, ...submission } = found;
      return {
        ...submission,
        currentlyProvisional: isCurrentlyProvisional(openItems),
        supersededById: supersededBy === null ? null : supersededBy.id,
        // The whole lineage this set sits in, so the current issuance is
        // answerable from any link in it (issue #7).
        chain: await supersedeChain(prisma, found),
        // Where each item stood when the set went out, carried on the
        // item itself: null for one attached afterwards.
        openItems: openItems.map((row) => ({
          ...row.openItem,
          unresolvedAtIssuance: row.unresolvedAtIssuance,
        })),
      };
    },
  );

  /**
   * Exposure: the issued submissions currently carrying unresolved open
   * items — one of the two uncombined counts that replaced the health
   * score (ADR-0016). Every project's, or one project's with `projectId`.
   *
   * A list, not a number. The count is its length, so clicking a count and
   * landing on the rows it counted cannot show a different set — and there
   * is nothing here to combine with a second figure into a score.
   *
   * Archived projects drop out of the count across every project, because
   * exposure is one of the daily counts and a finished job is not part of
   * today's work (glossary, **Pending items**). Asked about one job
   * directly, its own record still answers.
   */
  v1.get<{ Querystring: { projectId?: string } }>(
    '/exposure',
    { schema: { querystring: exposureQuerySchema } },
    async (request, reply) => {
      const { projectId } = request.query;
      if (projectId !== undefined) {
        const project = await prisma.project.findUnique({
          where: { id: projectId },
          select: { id: true },
        });
        // Nothing to act on and no such job are not the same answer, and
        // an empty list would read as the first.
        if (project === null) {
          return noSuchProject(reply);
        }
      }

      const carrying = await prisma.submission.findMany({
        where: {
          openItems: { some: { openItem: { resolvedAt: null } } },
          // Superseded ancestors are not what is out there. A reissue
          // carries the same unresolved items forward, so without this
          // every correction would count its set twice (issue #7).
          supersededBy: { is: null },
          ...(projectId === undefined
            ? { project: { archivedAt: null } }
            : { projectId }),
        },
        orderBy: [{ issuedAt: 'asc' }, { createdAt: 'asc' }],
        include: {
          phase: true,
          project: { select: { id: true, projectNumber: true, name: true } },
          ...derivedState,
        },
      });
      return carrying.map(withDerivedState);
    },
  );

  /**
   * An open item raised while recording an issuance. Its subject is the
   * project, not the submission — an item that vanished from the project
   * screen the moment it was tied to a set would be the opposite of
   * "nothing sitting in my court" (ADR-0026).
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
    '/submissions/:id/open-items',
    { schema: { body: openItemBodySchema } },
    async (request, reply) => {
      const submission = await prisma.submission.findUnique({
        where: { id: request.params.id },
        select: { id: true, projectId: true },
      });
      if (submission === null) {
        return noSuchSubmission(reply);
      }

      const { unresolved, ...rest } = request.body;
      const item = await prisma.openItem.create({
        data: itemOnSubmission(rest, submission, unresolved, timeSource),
      });
      return reply.code(201).send(item);
    },
  );

  /**
   * Attaching an item that is already on the set is refused rather than
   * repeated, matching the resolve rule: a silent second attach would
   * hide a double click behind a claim about what an issuance rested on.
   */
  v1.post<{ Params: { id: string; openItemId: string } }>(
    '/submissions/:id/open-items/:openItemId',
    async (request, reply) => {
      const { id, openItemId } = request.params;
      const submission = await prisma.submission.findUnique({
        where: { id },
        select: { id: true, projectId: true },
      });
      if (submission === null) {
        return noSuchSubmission(reply);
      }

      const badItem = await openItemRefusal(
        prisma,
        openItemId,
        submission.projectId,
      );
      if (badItem !== null) {
        return refuse(reply, badItem);
      }

      try {
        await prisma.submissionOpenItem.create({
          data: { submissionId: submission.id, openItemId },
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          return reply.code(409).send({
            message: 'that open item is already on this submission',
          });
        }
        throw error;
      }
      return reply.code(204).send();
    },
  );

  /**
   * Detaching says nothing about the open item, which stays on its
   * project. An item attached to the wrong set is a typo, and the
   * alternative is an unremovable claim about what went out.
   *
   * Narrowed to items attached *after* the issuance. The snapshot of what
   * was unresolved at that moment lives on these rows, so deleting one the
   * set was issued resting on would erase the record by cleanup — the
   * collision ADR-0026 recorded for this ticket to settle.
   */
  v1.delete<{ Params: { id: string; openItemId: string } }>(
    '/submissions/:id/open-items/:openItemId',
    async (request, reply) => {
      const { id, openItemId } = request.params;
      const submission = await prisma.submission.findUnique({
        where: { id },
        select: { id: true },
      });
      if (submission === null) {
        return noSuchSubmission(reply);
      }

      const key = { submissionId_openItemId: { submissionId: id, openItemId } };
      const attached = await prisma.submissionOpenItem.findUnique({
        where: key,
        select: { unresolvedAtIssuance: true },
      });
      // The submission exists, so a miss here is about the item: saying
      // "no submission with that id" would send the reader looking in
      // entirely the wrong place.
      if (attached === null) {
        return reply
          .code(404)
          .send({ message: 'that open item is not on this submission' });
      }
      if (attached.unresolvedAtIssuance !== null) {
        return reply.code(409).send({
          message: 'this submission was issued resting on that open item',
        });
      }

      // An item raised from a flag was never attached by hand, so it
      // cannot be on the wrong set — it was created against this very
      // submission by the record that raised it (issue #8). Detaching it
      // would let a flag be raised and then dropped, which is the one
      // thing story 40 exists to prevent, and would leave the record
      // saying the flag was raised against a set it no longer sits on.
      // Raised in error is answered by resolving the item with a note,
      // which is how every other open item is retired.
      const raised = await prisma.raisedFlag.findUnique({
        where: { openItemId },
        select: { assumptionRecord: { select: { submissionId: true } } },
      });
      if (raised?.assumptionRecord.submissionId === id) {
        return reply.code(409).send({
          message: 'that open item was raised from a flag on this submission',
        });
      }

      await prisma.submissionOpenItem.delete({ where: key });
      return reply.code(204).send();
    },
  );

}
