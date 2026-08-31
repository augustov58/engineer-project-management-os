/** Registers: the log of one correspondence type, and whose move it is (issue #14). */

import type { FastifyInstance } from 'fastify';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import type { TimeSource } from '../time-source.js';
import { NOT_BLANK, type RouteDependencies, instant, isUniqueViolation } from '../http.js';
import {
  noSuchProject,
  noSuchRegister,
  noSuchRegisterEntry,
  noSuchSubmission,
  openItemRefusal,
  refuse,
} from '../refusals.js';
import { openItemBodySchema } from './open-items.js';

/**
 * A handoff: from this moment, the ball is in the named party's court.
 *
 * `inOurCourt` is required and has no default. Issue #15 sums the intervals
 * where it is true, so a caller that could leave it off would be leaving off
 * the one fact the clock reads — and whichever way the default fell, half the
 * handoffs entered would be silently wrong.
 */
const handoffBodySchema = {
  type: 'object',
  required: ['party', 'inOurCourt'],
  additionalProperties: false,
  properties: {
    party: { type: 'string', pattern: NOT_BLANK, maxLength: 120 },
    inOurCourt: { type: 'boolean' },
    heldSince: { type: 'string', format: 'date-time' },
  },
} as const;

/**
 * A piece of correspondence, and where the ball starts.
 *
 * The first handoff is named in the same call that records the entry, which is
 * the shape ADR-0026 gave what a submission rests on and for its reason: an
 * entry logged is a thing already sitting in somebody's court, so there has to
 * be a moment at which both the row and its holder exist together. It is also
 * what makes the derived current holder total — there is no entry whose
 * ball-in-court is nobody, and no screen that has to render one.
 *
 * `question` is admitted here and refused by the route on a submittal: which
 * kind may carry it is the register's fact, and a body schema cannot see the
 * register. Caps follow the corpus — 32 for a designation written by hand, 200
 * for a subject line, 120 for a party, and the sheet list's 2000 for the one
 * field that holds more than a phrase.
 */
const entryBodySchema = {
  type: 'object',
  required: ['number', 'subject', 'fromParty', 'toParty', 'ballInCourt'],
  additionalProperties: false,
  properties: {
    number: { type: 'string', pattern: NOT_BLANK, maxLength: 32 },
    subject: { type: 'string', pattern: NOT_BLANK, maxLength: 200 },
    fromParty: { type: 'string', pattern: NOT_BLANK, maxLength: 120 },
    toParty: { type: 'string', pattern: NOT_BLANK, maxLength: 120 },
    question: { type: 'string', pattern: NOT_BLANK, maxLength: 2000 },
    ballInCourt: handoffBodySchema,
  },
} as const;

/** What was answered, capped at what was asked. */
const responseBodySchema = {
  type: 'object',
  required: ['response'],
  additionalProperties: false,
  properties: {
    response: {
      type: 'string',
      pattern: NOT_BLANK,
      maxLength: entryBodySchema.properties.question.maxLength,
    },
  },
} as const;

/** The issuance that answered the entry (story 81). */
const linkSubmissionBodySchema = {
  type: 'object',
  required: ['submissionId'],
  additionalProperties: false,
  properties: { submissionId: { type: 'string' } },
} as const;

interface HandoffBody {
  party: string;
  inOurCourt: boolean;
  heldSince?: string;
}

interface EntryBody {
  number: string;
  subject: string;
  fromParty: string;
  toParty: string;
  question?: string;
  ballInCourt: HandoffBody;
}

/**
 * What an entry is read with: every handoff of it, oldest first, the open
 * items being chased for it, and the log it is in.
 *
 * The handoffs come back in the order the ball actually moved rather than the
 * order they were entered, because a transmittal log is written up after the
 * fact and out of order — and because issue #15 pairs them into intervals,
 * which only means anything on that ordering. `createdAt` breaks a tie, so
 * two handoffs stamped the same instant still have a last one.
 */
const entryInclude = {
  handoffs: { orderBy: [{ heldSince: 'asc' }, { createdAt: 'asc' }] },
  openItems: {
    orderBy: { openItem: { waitingSince: 'asc' } },
    select: { openItem: true },
  },
  register: { select: { kind: true, projectId: true } },
} satisfies Prisma.RegisterEntryInclude;

type StoredEntry = Prisma.RegisterEntryGetPayload<{
  include: typeof entryInclude;
}>;

/**
 * An entry on the wire: whose move it is now, and the whole of how it got
 * there.
 *
 * *Ball-in-court* is the last handoff, derived on every read and stored
 * nowhere — the shape ADR-0027 gave *currently provisional* and ADR-0028 gave
 * *superseded*. A column beside the events would be a second place the same
 * fact lives, free to disagree with the history in exactly the dispute the
 * history exists to settle.
 *
 * The kind and the job come off the register rather than being columns here:
 * a screen needs both to render an entry at all, and neither can drift from
 * the row it is read from.
 */
function withBallInCourt(entry: StoredEntry) {
  const { handoffs, openItems, register, ...rest } = entry;
  return {
    ...rest,
    kind: register.kind,
    projectId: register.projectId,
    // `?? null` for the wire and not as a defence: an entry is created with
    // its first handoff in the same transaction and nothing deletes one, so
    // the list is never empty — but `at(-1)` is typed `| undefined`, and an
    // undefined would drop the key out of the JSON entirely and take the
    // exact-key-set test with it.
    ballInCourt: handoffs.at(-1) ?? null,
    handoffs,
    openItems: openItems.map((row) => row.openItem),
  };
}

/** A register with its entries, newest logged last. */
const registerInclude = {
  entries: { orderBy: { createdAt: 'asc' }, include: entryInclude },
} satisfies Prisma.RegisterInclude;

function withEntries(
  register: Prisma.RegisterGetPayload<{ include: typeof registerInclude }>,
) {
  return { ...register, entries: register.entries.map(withBallInCourt) };
}

/**
 * The entry, and the two facts about it that live on the register.
 *
 * Every route below one of these paths needs the kind to know whether a
 * question applies and the project to check an open item or a submission
 * against, so they are fetched together rather than in a second query each.
 */
function findEntry(prisma: PrismaClient, id: string) {
  return prisma.registerEntry.findUnique({
    where: { id },
    select: {
      id: true,
      response: true,
      submissionId: true,
      register: { select: { kind: true, projectId: true } },
    },
  });
}

/** The entry as it goes out, read back after whatever just changed. */
async function readEntry(prisma: PrismaClient, id: string) {
  const entry = await prisma.registerEntry.findUniqueOrThrow({
    where: { id },
    include: entryInclude,
  });
  return withBallInCourt(entry);
}

/** A handoff row from the body every writer of that table validates. */
function handoffData(body: HandoffBody, timeSource: TimeSource) {
  return {
    party: body.party,
    inOurCourt: body.inOurCourt,
    heldSince: instant(body.heldSince, timeSource),
    createdAt: timeSource.now(),
  };
}

export function registerRoutes(
  v1: FastifyInstance,
  { prisma, timeSource }: RouteDependencies,
): void {
  /**
   * Both logs for a job, always two and always in the same order: submittals
   * first, as the MVP workflow and the glossary both name them.
   */
  v1.get<{ Params: { id: string } }>(
    '/projects/:id/registers',
    async (request, reply) => {
      const project = await prisma.project.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (project === null) {
        return noSuchProject(reply);
      }

      const registers = await prisma.register.findMany({
        where: { projectId: project.id },
        // `kind` ascending is the enum's declaration order, which is
        // SUBMITTAL then RFI — the order the corpus writes the pair in
        // everywhere it names them.
        orderBy: { kind: 'asc' },
        include: registerInclude,
      });
      return registers.map(withEntries);
    },
  );

  v1.get<{ Params: { id: string } }>(
    '/registers/:id',
    async (request, reply) => {
      const register = await prisma.register.findUnique({
        where: { id: request.params.id },
        include: registerInclude,
      });
      return register === null ? noSuchRegister(reply) : withEntries(register);
    },
  );

  /**
   * Log a piece of correspondence, and say whose court it starts in.
   *
   * The entry and its first handoff are one transaction: an entry with no
   * handoff would be a row whose current holder is nobody, and the screen
   * showing it would have to invent a way to say so.
   */
  v1.post<{ Params: { id: string }; Body: EntryBody }>(
    '/registers/:id/entries',
    { schema: { body: entryBodySchema } },
    async (request, reply) => {
      const register = await prisma.register.findUnique({
        where: { id: request.params.id },
        select: { id: true, kind: true },
      });
      if (register === null) {
        return noSuchRegister(reply);
      }

      const { ballInCourt, question, ...entry } = request.body;

      // Which kind carries a question is the register's fact, so the body
      // schema cannot enforce it and the route does. Both directions are
      // refused: an RFI is a question, and a submittal that could carry one
      // would be an RFI filed in the wrong log.
      if (register.kind === 'RFI' && question === undefined) {
        return reply.code(409).send({ message: 'an RFI needs a question' });
      }
      if (register.kind === 'SUBMITTAL' && question !== undefined) {
        return reply.code(409).send({ message: 'a submittal has no question' });
      }

      const now = timeSource.now();
      try {
        const logged = await prisma.registerEntry.create({
          data: {
            ...entry,
            question: question ?? null,
            registerId: register.id,
            createdAt: now,
            handoffs: { create: handoffData(ballInCourt, timeSource) },
          },
          include: entryInclude,
        });
        return reply.code(201).send(withBallInCourt(logged));
      } catch (error) {
        // Unqualified, and safe to be: `(register_id, number)` is the only
        // constraint this insert can hit.
        if (isUniqueViolation(error)) {
          return reply
            .code(409)
            .send({ message: 'that number is already in this register' });
        }
        throw error;
      }
    },
  );

  v1.get<{ Params: { id: string } }>(
    '/register-entries/:id',
    async (request, reply) => {
      const entry = await prisma.registerEntry.findUnique({
        where: { id: request.params.id },
        include: entryInclude,
      });
      return entry === null
        ? noSuchRegisterEntry(reply)
        : withBallInCourt(entry);
    },
  );

  /**
   * Hand the ball on (stories 71, 80).
   *
   * Every handoff is a row and none is ever rewritten, which is what makes the
   * turnaround dispute settleable by the record. There is deliberately no
   * refusal for handing it to whoever already holds it: a submittal that comes
   * back for a second review is genuinely in our court twice, and the two
   * intervals are two intervals.
   */
  v1.post<{ Params: { id: string }; Body: HandoffBody }>(
    '/register-entries/:id/handoffs',
    { schema: { body: handoffBodySchema } },
    async (request, reply) => {
      const entry = await findEntry(prisma, request.params.id);
      if (entry === null) {
        return noSuchRegisterEntry(reply);
      }

      await prisma.ballInCourtEvent.create({
        data: {
          registerEntryId: entry.id,
          ...handoffData(request.body, timeSource),
        },
      });
      return reply.code(201).send(await readEntry(prisma, entry.id));
    },
  );

  /**
   * What came back (story 78).
   *
   * Recorded once and refused a second time, the shape ADR-0031 gave closing
   * an issue and for its reason: a second call would silently overwrite the
   * answer on the record, and an answer is the substance the register exists
   * to hold. A correction to a wrong answer is not in this ticket; it would be
   * another entry, as a correction is elsewhere in this product.
   */
  v1.post<{ Params: { id: string }; Body: { response: string } }>(
    '/register-entries/:id/response',
    { schema: { body: responseBodySchema } },
    async (request, reply) => {
      const entry = await findEntry(prisma, request.params.id);
      if (entry === null) {
        return noSuchRegisterEntry(reply);
      }
      if (entry.register.kind !== 'RFI') {
        return reply
          .code(409)
          .send({ message: 'only an RFI has a response' });
      }
      if (entry.response !== null) {
        return reply
          .code(409)
          .send({ message: 'that entry already has a response' });
      }

      await prisma.registerEntry.update({
        where: { id: entry.id },
        data: { response: request.body.response },
      });
      return readEntry(prisma, entry.id);
    },
  );

  /**
   * The issuance that answered the entry, so a resubmittal and its issuance
   * are one story (story 81).
   *
   * The column is on the entry and the write happens here, never on the
   * submission: a set that has gone out is not edited, which ADR-0026 made
   * true by construction rather than by a guard, and a route that wrote to
   * `submissions` to record this would be the first to break it. Story 35
   * asks for the same link from the other side and reads through this column
   * in reverse.
   *
   * Linked once and refused a second time. The entry names what responded to
   * it, and quietly repointing that at a different issuance would rewrite what
   * the record said happened.
   */
  v1.post<{ Params: { id: string }; Body: { submissionId: string } }>(
    '/register-entries/:id/submission',
    { schema: { body: linkSubmissionBodySchema } },
    async (request, reply) => {
      const entry = await findEntry(prisma, request.params.id);
      if (entry === null) {
        return noSuchRegisterEntry(reply);
      }
      if (entry.submissionId !== null) {
        return reply
          .code(409)
          .send({ message: 'that entry is already linked to a submission' });
      }

      const submission = await prisma.submission.findUnique({
        where: { id: request.body.submissionId },
        select: { id: true, projectId: true },
      });
      if (submission === null) {
        return noSuchSubmission(reply);
      }
      if (submission.projectId !== entry.register.projectId) {
        return reply
          .code(409)
          .send({ message: 'that submission belongs to another project' });
      }

      await prisma.registerEntry.update({
        where: { id: entry.id },
        data: { submissionId: submission.id },
      });
      return readEntry(prisma, entry.id);
    },
  );

  /**
   * "Cannot review this until the load data arrives", captured where the
   * clock is running (story 79).
   *
   * The item's subject stays `PROJECT` and the entry is a join — the third
   * record to be asked and the third to answer the same way (ADR-0026,
   * ADR-0031). Nothing in the pending items view changes to make this work,
   * which is the sign the shape is right.
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
    '/register-entries/:id/open-items',
    { schema: { body: openItemBodySchema } },
    async (request, reply) => {
      const entry = await findEntry(prisma, request.params.id);
      if (entry === null) {
        return noSuchRegisterEntry(reply);
      }

      const { waitingSince, ...rest } = request.body;
      const item = await prisma.openItem.create({
        data: {
          ...rest,
          subjectType: 'PROJECT',
          subjectId: entry.register.projectId,
          waitingSince: instant(waitingSince, timeSource),
          registerEntries: { create: { registerEntryId: entry.id } },
        },
      });
      return reply.code(201).send(item);
    },
  );

  /** An item already on the job, chased for this entry as well. */
  v1.post<{ Params: { id: string; openItemId: string } }>(
    '/register-entries/:id/open-items/:openItemId',
    async (request, reply) => {
      const { id, openItemId } = request.params;
      const entry = await findEntry(prisma, id);
      if (entry === null) {
        return noSuchRegisterEntry(reply);
      }

      const badItem = await openItemRefusal(
        prisma,
        openItemId,
        entry.register.projectId,
      );
      if (badItem !== null) {
        return refuse(reply, badItem);
      }

      try {
        await prisma.registerEntryOpenItem.create({
          data: { registerEntryId: entry.id, openItemId },
        });
      } catch (error) {
        // Unqualified, and safe to be: the composite key is the only
        // constraint this insert can hit.
        if (isUniqueViolation(error)) {
          return reply
            .code(409)
            .send({ message: 'that open item is already on this entry' });
        }
        throw error;
      }
      return reply.code(204).send();
    },
  );

}
