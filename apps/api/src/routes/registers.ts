/**
 * Registers: the log of one correspondence type, whose move it is (issue #14),
 * and how long it has been ours (issue #15).
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
  noSuchProject,
  noSuchRegister,
  noSuchRegisterEntry,
  noSuchSubmission,
  openItemRefusal,
  refuse,
} from '../refusals.js';
import { openItemBodySchema } from './open-items.js';

const DAY = 24 * 60 * 60 * 1000;

/**
 * The closed set of five, byte-exact and in the order every source writes them
 * (story 75).
 *
 * Refused here at the boundary and again by a CHECK underneath — the double
 * enforcement ADR-0030 gave the one-axis rule and ADR-0031 gave an issue's
 * category, and what "enforce them in the schema, not only in the interface"
 * asks for. One string is stored, sent, selected and printed, playing all four
 * parts, which is why this is not a database enum: three of the five cannot be
 * named as Prisma enum members at all (ADR-0036).
 */
const DISPOSITIONS = [
  'Approved',
  'Approved as Noted',
  'Revise and Resubmit',
  'Rejected',
  'For Record Only',
] as const;

type Disposition = (typeof DISPOSITIONS)[number];

/**
 * The contractual turnaround, in whole days (story 73).
 *
 * A duration and never a date: the day it falls due is a function of this and
 * of when the ball reached us, which the handoff history already holds. An
 * integer, because contracts name whole days. Bounded below at one — a
 * turnaround of zero is not a target — and above at a year, past which the
 * number is a typo rather than a term.
 */
const TURNAROUND_DAYS = {
  type: 'integer',
  minimum: 1,
  maximum: 365,
} as const;

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
 *
 * `turnaroundDays` is optional here and settable afterwards, because the
 * contractual number is known when the entry is logged about as often as it is
 * looked up later — the shape ADR-0026 gave what a set rests on, which is
 * named in the same call and attachable after it.
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
    turnaroundDays: TURNAROUND_DAYS,
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

/** Which job's clock, or every live one's. Exposure's querystring exactly. */
const clockQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { projectId: { type: 'string' } },
} as const;

/** The contractual number the clock is measured against (story 73). */
const turnaroundBodySchema = {
  type: 'object',
  required: ['turnaroundDays'],
  additionalProperties: false,
  properties: { turnaroundDays: TURNAROUND_DAYS },
} as const;

/**
 * The outcome of a review, and where the ball goes (stories 75, 76).
 *
 * The handoff is part of this body and not a second call, which is what makes
 * closing the loop one action — and the party is **supplied** rather than read
 * off `fromParty`. The entry's two parties are its fixed cast and are
 * deliberately not read as whose move it is (ADR-0036): a submittal reviewed
 * for a contractor may go back to the architect, and a route that guessed
 * would write a handoff nobody asked for into the record a dispute is settled
 * from.
 */
const dispositionBodySchema = {
  type: 'object',
  required: ['disposition', 'ballInCourt'],
  additionalProperties: false,
  properties: {
    disposition: { type: 'string', enum: DISPOSITIONS },
    ballInCourt: handoffBodySchema,
  },
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
  turnaroundDays?: number;
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
  // The round that followed this one, if a resubmittal came back. Selected
  // rather than included: `previous_round_id` is unique, so there is at most
  // one and its id is the whole of what a screen needs to link forward — the
  // shape `supersededById` has on a submission (ADR-0028).
  nextRound: { select: { id: true } },
  register: { select: { kind: true, projectId: true } },
} satisfies Prisma.RegisterEntryInclude;

type StoredEntry = Prisma.RegisterEntryGetPayload<{
  include: typeof entryInclude;
}>;

/**
 * An entry on the wire: whose move it is now, how long it has been ours, and
 * the whole of how it got there.
 *
 * `…OnTheWire` rather than `withBallInCourt`, matching `photoOnTheWire` and
 * `reportOnTheWire`: it attaches five facts now, not one, and a name for the
 * first of them would not describe it.
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
 *
 * `inCourtMs` and `pastClock` are derived here too, for the same reason and by
 * the same rule (issue #15). Neither is a column: a stored elapsed time would
 * be wrong a millisecond after it was written, and a stored *past its clock*
 * would be wrong for however long nothing rewrote it.
 */
function entryOnTheWire(entry: StoredEntry, timeSource: TimeSource) {
  const { handoffs, openItems, nextRound, register, ...rest } = entry;
  // `?? null` for the wire and not as a defence: an entry is created with
  // its first handoff in the same transaction and nothing deletes one, so
  // the list is never empty — but `at(-1)` is typed `| undefined`, and an
  // undefined would drop the key out of the JSON entirely and take the
  // exact-key-set test with it.
  const ballInCourt = handoffs.at(-1) ?? null;
  const inCourt = inCourtMs(handoffs, timeSource.now());
  return {
    ...rest,
    kind: register.kind,
    projectId: register.projectId,
    nextRoundId: nextRound === null ? null : nextRound.id,
    ballInCourt,
    inCourtMs: inCourt,
    pastClock: isPastClock(rest.turnaroundDays, ballInCourt, inCourt),
    handoffs,
    openItems: openItems.map((row) => row.openItem),
  };
}

/**
 * Elapsed in-court time: the sum of the intervals in which the ball was ours
 * (story 72).
 *
 * Each handoff opens an interval that the next one closes, and the last is
 * still open, so it runs to now. Only the intervals whose handoff says
 * `inOurCourt` are added — the boolean and never the party's name, because a
 * job that calls us by the firm's name still accrues and a third party named
 * "us" does not (ADR-0036). Time spent waiting on somebody else is not counted
 * against us, which is the whole of what the clock is for.
 *
 * **No interval may end after now.** A transmittal log is written up by hand,
 * so a handoff can carry a date that has not arrived — and then the interval
 * it closes would credit time nobody has spent yet, which on an entry still in
 * our court would put it past its clock on days that have not happened. Both
 * clamps are for that one case: `min` keeps an interval from ending in the
 * future, and `max` keeps one that starts there from subtracting. Between two
 * handoffs in the past neither can bind, because the list arrives ordered by
 * `heldSince`.
 */
function inCourtMs(
  handoffs: { inOurCourt: boolean; heldSince: Date }[],
  now: Date,
): number {
  let total = 0;
  for (const [index, handoff] of handoffs.entries()) {
    if (!handoff.inOurCourt) {
      continue;
    }
    // The last interval is open and runs to now; a closed one runs to the
    // handoff that ended it, or to now if that has not arrived.
    const closed = handoffs[index + 1]?.heldSince;
    const ends = Math.min(closed?.getTime() ?? now.getTime(), now.getTime());
    total += Math.max(0, ends - handoff.heldSince.getTime());
  }
  return total;
}

/**
 * Whether this entry is sitting in our court past its clock (stories 43, 74).
 *
 * Three facts and all three are required. The ball has to be **ours now** —
 * "nothing sitting in my court past its clock" is the outcome test, and an
 * entry we handed back is not sitting in our court however long it took us,
 * which is also why recording a disposition takes one off this list without
 * anything having to stop a clock. There has to be a target, because past
 * *what* is otherwise a guess and story 73 exists to remove the guess. And the
 * elapsed time has to exceed it: exactly the target is not past it.
 */
function isPastClock(
  turnaroundDays: number | null,
  ballInCourt: { inOurCourt: boolean } | null,
  inCourt: number,
): boolean {
  if (turnaroundDays === null || ballInCourt === null) {
    return false;
  }
  return ballInCourt.inOurCourt && inCourt > turnaroundDays * DAY;
}

/** A register with its entries, newest logged last. */
const registerInclude = {
  entries: { orderBy: { createdAt: 'asc' }, include: entryInclude },
} satisfies Prisma.RegisterInclude;

function withEntries(
  register: Prisma.RegisterGetPayload<{ include: typeof registerInclude }>,
  timeSource: TimeSource,
) {
  return {
    ...register,
    entries: register.entries.map((entry) =>
      entryOnTheWire(entry, timeSource),
    ),
  };
}

/**
 * The same entry, carrying the job it is on — what a cross-project view needs
 * and a single register's screen already knows.
 *
 * Exposure's shape: `{ id, projectNumber, name }`, so the two daily lists say
 * which job in the same words.
 */
const clockInclude = {
  ...entryInclude,
  register: {
    select: {
      kind: true,
      projectId: true,
      project: { select: { id: true, projectNumber: true, name: true } },
    },
  },
} satisfies Prisma.RegisterEntryInclude;

function withProject(
  entry: Prisma.RegisterEntryGetPayload<{ include: typeof clockInclude }>,
  timeSource: TimeSource,
) {
  return {
    ...entryOnTheWire(entry, timeSource),
    project: entry.register.project,
  };
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
      registerId: true,
      response: true,
      submissionId: true,
      turnaroundDays: true,
      disposition: true,
      // Whether a round already follows this one. Selected rather than
      // counted: `previous_round_id` is unique, so there is at most one and
      // its existence is the whole of the refusal.
      nextRound: { select: { id: true } },
      register: { select: { kind: true, projectId: true } },
    },
  });
}

/** The entry as it goes out, read back after whatever just changed. */
async function readEntry(
  prisma: PrismaClient,
  id: string,
  timeSource: TimeSource,
) {
  const entry = await prisma.registerEntry.findUniqueOrThrow({
    where: { id },
    include: entryInclude,
  });
  return entryOnTheWire(entry, timeSource);
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
      return registers.map((one) => withEntries(one, timeSource));
    },
  );

  v1.get<{ Params: { id: string } }>(
    '/registers/:id',
    async (request, reply) => {
      const register = await prisma.register.findUnique({
        where: { id: request.params.id },
        include: registerInclude,
      });
      return register === null
        ? noSuchRegister(reply)
        : withEntries(register, timeSource);
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
        return reply.code(201).send(entryOnTheWire(logged, timeSource));
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
        : entryOnTheWire(entry, timeSource);
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
      return reply.code(201).send(await readEntry(prisma, entry.id, timeSource));
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
      return readEntry(prisma, entry.id, timeSource);
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
      return readEntry(prisma, entry.id, timeSource);
    },
  );

  /**
   * The contractual number "past its clock" is measured against (story 73).
   *
   * Set once and refused a second time, the shape this record already gives a
   * response and a link. A target is not an opinion that gets revised: moving
   * it moves which entries were past their clock, backwards through every day
   * the number was different, and the daily layer is only worth trusting if it
   * cannot be made to have said something else. A wrong one is corrected the
   * way everything else here is — by another entry, or not at all.
   *
   * It may also be named in the call that logs the entry, which is where it is
   * usually known.
   */
  v1.post<{ Params: { id: string }; Body: { turnaroundDays: number } }>(
    '/register-entries/:id/turnaround',
    { schema: { body: turnaroundBodySchema } },
    async (request, reply) => {
      const entry = await findEntry(prisma, request.params.id);
      if (entry === null) {
        return noSuchRegisterEntry(reply);
      }
      if (entry.turnaroundDays !== null) {
        return reply
          .code(409)
          .send({ message: 'that entry already has a turnaround target' });
      }

      await prisma.registerEntry.update({
        where: { id: entry.id },
        data: { turnaroundDays: request.body.turnaroundDays },
      });
      return readEntry(prisma, entry.id, timeSource);
    },
  );

  /**
   * The outcome of a review: stop the clock and hand the ball back, in one
   * action (stories 75, 76).
   *
   * One call and one transaction, because they are one thing that happened. It
   * stops the clock by **handing the ball back** and not by writing a stop:
   * accrual reads the handoffs, so a ball that is no longer ours no longer
   * accrues and the entry drops off the past-its-clock list on the next read.
   * ADR-0036 left room for exactly this — "a terminal event is still
   * expressible" — and taking it means there is no `clock_stopped` column to
   * disagree with the history.
   *
   * `disposed_at` is stamped from the handoff's own instant, so a review
   * entered from a transmittal log a week later is dated when it happened and
   * not when it was typed. The two are written together and neither derives
   * the other afterwards: a later handoff moves the ball again and the
   * disposition stands, which is the shape ADR-0027 gave `issued_provisional`.
   *
   * Recorded once and refused a second time (ADR-0031's close): a second call
   * would silently overwrite the outcome of a review, and the outcome is the
   * thing the closed set exists to keep comparable.
   */
  v1.post<{
    Params: { id: string };
    Body: { disposition: Disposition; ballInCourt: HandoffBody };
  }>(
    '/register-entries/:id/disposition',
    { schema: { body: dispositionBodySchema } },
    async (request, reply) => {
      const entry = await findEntry(prisma, request.params.id);
      if (entry === null) {
        return noSuchRegisterEntry(reply);
      }
      // Only a submittal is reviewed to a disposition, and the kind lives on
      // the register — so this is the boundary's, as the question rule is.
      if (entry.register.kind !== 'SUBMITTAL') {
        return reply
          .code(409)
          .send({ message: 'only a submittal has a disposition' });
      }
      if (entry.disposition !== null) {
        return reply
          .code(409)
          .send({ message: 'that entry already has a disposition' });
      }

      const handoff = handoffData(request.body.ballInCourt, timeSource);
      await prisma.$transaction([
        prisma.registerEntry.update({
          where: { id: entry.id },
          data: {
            disposition: request.body.disposition,
            disposedAt: handoff.heldSince,
          },
        }),
        prisma.ballInCourtEvent.create({
          data: { registerEntryId: entry.id, ...handoff },
        }),
      ]);
      return readEntry(prisma, entry.id, timeSource);
    },
  );

  /**
   * The round that came back, connected to the one it follows (story 77).
   *
   * A new row pointing backwards and nothing written to the round it replaces
   * — ADR-0028's reissue, arriving for a second record. The successor starts
   * its own clock from its own first handoff and takes its own turnaround
   * target, inheriting neither: carrying a number forward would be the product
   * asserting a contractual term nobody typed.
   *
   * Not narrowed to a Revise and Resubmit. It is that disposition the screen
   * offers this on, but a transmittal log is written up after the fact and out
   * of order (ADR-0036), so requiring the review to have been entered first
   * would refuse a legitimate backfill. What is refused is a second next round,
   * by the unique column and not by this guard, which is only what makes the
   * message say why.
   */
  v1.post<{ Params: { id: string }; Body: EntryBody }>(
    '/register-entries/:id/next-round',
    { schema: { body: entryBodySchema } },
    async (request, reply) => {
      const previous = await findEntry(prisma, request.params.id);
      if (previous === null) {
        return noSuchRegisterEntry(reply);
      }
      if (previous.register.kind !== 'SUBMITTAL') {
        return reply
          .code(409)
          .send({ message: 'only a submittal has another round' });
      }
      if (previous.nextRound !== null) {
        return reply
          .code(409)
          .send({ message: 'that entry already has a next round' });
      }

      const { ballInCourt, question, ...entry } = request.body;
      if (question !== undefined) {
        return reply.code(409).send({ message: 'a submittal has no question' });
      }

      try {
        const logged = await prisma.registerEntry.create({
          data: {
            ...entry,
            question: null,
            registerId: previous.registerId,
            previousRoundId: previous.id,
            createdAt: timeSource.now(),
            handoffs: { create: handoffData(ballInCourt, timeSource) },
          },
          include: entryInclude,
        });
        return reply.code(201).send(entryOnTheWire(logged, timeSource));
      } catch (error) {
        // Qualified, unlike the plain create: this insert can hit two unique
        // constraints, and answering the wrong sentence to a collision is a
        // lie at the one moment anybody reads it.
        if (violates(error, 'previous_round_id')) {
          return reply
            .code(409)
            .send({ message: 'that entry already has a next round' });
        }
        if (violates(error, 'number')) {
          return reply
            .code(409)
            .send({ message: 'that number is already in this register' });
        }
        throw error;
      }
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

  /**
   * The clock: every entry sitting in our court past its turnaround, longest
   * first (stories 43, 74).
   *
   * A **list and not a number**, the shape ADR-0027 gave exposure and for its
   * reason: every count on every screen is this list's length, so clicking a
   * count lands on exactly the entries it counted and there is no figure in
   * the payload to combine with exposure into a score (ADR-0016).
   *
   * Longest in our court first, which is what "oldest first" means for a
   * record whose age is the time it has spent with us — the same sense the
   * pending items view sorts by, and the same number the entry's own badge
   * shows. Not "furthest past its target", which would reorder a 7-day RFI
   * above a 14-day submittal that has been here nine days longer. `createdAt`
   * breaks a tie so the order is total.
   *
   * Archived projects drop out of the across-every-project list and keep their
   * own, the line the glossary draws under **Pending items** and exposure
   * draws in the same place: this is one of the two daily counts, and a
   * finished job is not part of today's work. Asked about one job directly, an
   * archived one still answers.
   *
   * The filter cannot be a `where` clause: elapsed in-court time is a sum over
   * a child table's intervals with an open last one, so the rows are read and
   * the arithmetic decides. There are two registers per job.
   */
  v1.get<{ Querystring: { projectId?: string } }>(
    '/clock',
    { schema: { querystring: clockQuerySchema } },
    async (request, reply) => {
      const { projectId } = request.query;
      if (projectId !== undefined) {
        const project = await prisma.project.findUnique({
          where: { id: projectId },
          select: { id: true },
        });
        // Nothing to act on and no such job are not the same answer, and an
        // empty list would read as the first.
        if (project === null) {
          return noSuchProject(reply);
        }
      }

      const entries = await prisma.registerEntry.findMany({
        where: {
          register:
            projectId === undefined
              ? { project: { archivedAt: null } }
              : { projectId },
        },
        include: clockInclude,
      });

      return entries
        .map((entry) => withProject(entry, timeSource))
        .filter((entry) => entry.pastClock)
        .sort(
          (a, b) =>
            b.inCourtMs - a.inCourtMs ||
            a.createdAt.getTime() - b.createdAt.getTime(),
        );
    },
  );
}
