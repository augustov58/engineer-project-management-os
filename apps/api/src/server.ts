import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import type { ObjectStore } from './object-store.js';
import { systemTimeSource, type TimeSource } from './time-source.js';

export interface ServerDependencies {
  prisma: PrismaClient;
  queue: Queue;
  /** Where a photograph's bytes go. No default: there is no sensible one. */
  objectStore: ObjectStore;
  /** Defaults to the real clock; tests pass a fake and advance it by hand. */
  timeSource?: TimeSource;
  logger?: boolean;
}

/**
 * The plan's API shape is a versioned prefix (issue #1). One `register` call
 * carries it, so the version lives in a single place rather than in every path.
 */
const API_PREFIX = '/v1';

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

const UNIQUE_VIOLATION = 'P2002';

/** The one 404 body, so the two lookup routes cannot drift apart. */
function noSuchProject(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no project with that id' });
}

/**
 * A project as it goes out, which is the whole row **minus**
 * `issuesAllocated`.
 *
 * Named for the wire rather than for the transformation, and the only helper
 * here that removes a field where `withDate`, `withLocation` and
 * `withSightings` all add one — so that a route returning a project without
 * calling it reads as the omission it is.
 *
 * The column is bookkeeping for the issue identifier sequence (issue #10,
 * ADR-0031). It is a high-water mark and not a count: a refused promotion
 * rolls it back, but nothing else ever does, so a screen reading it as "issues
 * on this job" would be wrong the first time the two diverged. What a
 * project's issues are is `GET /projects/:id/issues`, whose length is the
 * count — the shape ADR-0027 gave exposure.
 *
 * Every route that returns a project calls it, and one test asserts the exact
 * key set of all five.
 */
function projectOnTheWire<T extends { issuesAllocated: number }>(project: T) {
  const { issuesAllocated: _sequence, ...onTheWire } = project;
  return onTheWire;
}

function isUniqueViolation(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === UNIQUE_VIOLATION
  );
}

/**
 * A unique violation, and specifically the one on the named column.
 * `writeIssuance` also writes join rows with a composite key of their own, so
 * an unqualified check would answer "that submission has already been
 * superseded" to a collision that had nothing to do with superseding — a
 * message that would be a lie at the one moment anybody read it.
 *
 * Matched against the whole of `meta` rather than a path into it. The pg
 * driver adapter reports the column under
 * `meta.driverAdapterError.cause.constraint.fields` and leaves `meta.target`
 * — the documented place — undefined, so reading the documented path would
 * quietly answer "not this constraint" to every violation and turn the race
 * this guards into a 500. Verified against a real P2002 from this schema.
 */
function violates(error: unknown, column: string): boolean {
  if (!isUniqueViolation(error)) {
    return false;
  }
  return JSON.stringify(error.meta ?? {}).includes(column);
}

/**
 * At least one character that is not whitespace. `minLength: 1` would accept
 * "   ", which stores as a filled-in field and reads as an empty one — and for
 * `waitingOn` would be indistinguishable on screen from nobody.
 */
const NOT_BLANK = '\\S';

/**
 * Caps are chosen the way the project name's 200 was: the plan states none,
 * and an unbounded column is a way to wedge the record. The counterfactual
 * and the resolution note get more room, being prose about consequences
 * rather than a name or a phrase.
 */
const openItemBodySchema = {
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
const UNRESOLVED_MAX = openItemBodySchema.properties.unresolved.maxLength;

/** Resolving takes a note and a date; only the date may be left to the clock. */
const resolveBodySchema = {
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

/** The one 404 body for open items, matching the projects one. */
function noSuchOpenItem(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no open item with that id' });
}

/**
 * A supplied instant, or the injected time source. Parsing a string the
 * engineer typed is not reading the wall clock, so ADR-0022 is satisfied by
 * the fallback being `timeSource.now()` and never `new Date()`.
 */
function instant(supplied: string | undefined, timeSource: TimeSource): Date {
  return supplied === undefined ? timeSource.now() : new Date(supplied);
}

/**
 * A phase is per-project free text — "50% CD", "90% CD", "Building Permit
 * Set" (ADR-0015). The cap matches a party name: these are labels an engineer
 * says out loud, not prose.
 */
const phaseBodySchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: { name: { type: 'string', pattern: NOT_BLANK, maxLength: 120 } },
} as const;

/**
 * Reordering submits the whole ordered list rather than one move. It is then
 * atomic and idempotent, and there is no off-by-one to get wrong in a
 * `{ phase, toIndex }` call (ADR-0026).
 */
const phaseOrderBodySchema = {
  type: 'object',
  required: ['phaseIds'],
  additionalProperties: false,
  properties: { phaseIds: { type: 'array', items: { type: 'string' } } },
} as const;

const currentPhaseBodySchema = {
  type: 'object',
  required: ['phaseId'],
  additionalProperties: false,
  properties: { phaseId: { type: 'string' } },
} as const;

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

/** The one 404 body for phases, matching the projects one. */
function noSuchPhase(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no phase with that id' });
}

/**
 * Why a record named in a request cannot be used here. Missing is a 404;
 * belonging to another job is a 409, because it exists and is simply not
 * this project's to issue at or to rest on.
 */
interface Refusal {
  code: number;
  message: string;
}

function refuse(reply: FastifyReply, refusal: Refusal) {
  return reply.code(refusal.code).send({ message: refusal.message });
}

async function phaseRefusal(
  prisma: PrismaClient,
  phaseId: string,
  projectId: string,
): Promise<Refusal | null> {
  const phase = await prisma.projectPhase.findUnique({
    where: { id: phaseId },
    select: { projectId: true },
  });
  if (phase === null) {
    return { code: 404, message: 'no phase with that id' };
  }
  if (phase.projectId !== projectId) {
    return { code: 409, message: 'that phase belongs to another project' };
  }
  return null;
}

async function openItemRefusal(
  prisma: PrismaClient,
  openItemId: string,
  projectId: string,
): Promise<Refusal | null> {
  const item = await prisma.openItem.findUnique({
    where: { id: openItemId },
    select: { subjectType: true, subjectId: true },
  });
  if (item === null) {
    return { code: 404, message: 'no open item with that id' };
  }
  if (item.subjectType !== 'PROJECT' || item.subjectId !== projectId) {
    return { code: 409, message: 'that open item is on another project' };
  }
  return null;
}

/** The one 404 body for submissions, matching the projects one. */
function noSuchSubmission(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no submission with that id' });
}

/**
 * The one already-superseded body. Said twice by the reissue route — once by
 * the check that reads the successor, once by the index catching a race — and
 * a reworded message must not become two different sentences.
 */
function alreadySuperseded(reply: FastifyReply) {
  return reply
    .code(409)
    .send({ message: 'that submission has already been superseded' });
}

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
 * The durable artifact of engineering reasoning (issue #8): two blocks
 * captured verbatim from a helper skill's output, with the code edition and
 * the date.
 *
 * The caps follow the sheet list's reasoning — this is the other field that
 * holds a list rather than a phrase, and real output from the three
 * calculators runs to a handful of lines and about a kilobyte. The code
 * edition gets the project name's 200, because one calculation may be done
 * against five standards at once.
 *
 * There is no `submissionId` here: which issuance a record justified is the
 * route it was captured on, not something a body may assert.
 */
const assumptionRecordBodySchema = {
  type: 'object',
  required: ['assumptions', 'flags', 'codeEdition'],
  additionalProperties: false,
  properties: {
    assumptions: { type: 'string', pattern: NOT_BLANK, maxLength: 4000 },
    flags: { type: 'string', pattern: NOT_BLANK, maxLength: 4000 },
    codeEdition: { type: 'string', pattern: NOT_BLANK, maxLength: 200 },
    // Settable, because the calculation worth capturing first was run long
    // before this row existed; otherwise the injected TimeSource (ADR-0022).
    calculatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

/** Capped at the open item's, being the same field on the other record. */
const counterfactualBodySchema = {
  type: 'object',
  required: ['counterfactual'],
  additionalProperties: false,
  properties: {
    counterfactual: { type: 'string', pattern: NOT_BLANK, maxLength: 1000 },
  },
} as const;

/**
 * An open item raised from a flag. The same fields as any other, except that
 * `unresolved` may be left off — the flag already says what is unresolved,
 * and story 40's point is that nothing about it gets transcribed by hand.
 *
 * The property definitions are the open item's own rather than a second copy,
 * so the caps cannot drift apart.
 */
const raisedFlagBodySchema = {
  type: 'object',
  required: ['blocks', 'waitingOn', 'counterfactual'],
  additionalProperties: false,
  properties: openItemBodySchema.properties,
} as const;

/**
 * A site visit: one dated observation event against a building (issue #9).
 *
 * Both instants are optional. The start falls back to the injected TimeSource
 * for a walk being recorded as it happens, and is supplied for one entered
 * afterwards — `issued_at`'s reasoning (ADR-0026). The end is left off while
 * the walk is still under way and stamped later by the end route, because the
 * per-floor schedule is recorded *during* the visit (story 50).
 *
 * There is no `visitedOn`: the date is the day of the start, derived on every
 * read, so a visit cannot be dated one day and started on another.
 */
const siteVisitBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    startedAt: { type: 'string', format: 'date-time' },
    endedAt: { type: 'string', format: 'date-time' },
  },
} as const;

/** Ending a walk. The instant only, and only if it is not the clock's. */
const endVisitBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { endedAt: { type: 'string', format: 'date-time' } },
} as const;

/**
 * The floor designation, without the word "Floor" — "3", "B1", "M", "PH".
 *
 * Free text and not an integer: the grammar writes `Floor N`, but a building
 * with a basement, a mezzanine or a penthouse has floors that are not numbers,
 * and an integer column could not record an observation made in any of them
 * (ADR-0030). Capped at the revision's 32, being the other short designation.
 */
const FLOOR = { type: 'string', pattern: NOT_BLANK, maxLength: 32 } as const;

/** Arriving on a floor. Leaving it is the complete route. */
const startFloorBodySchema = {
  type: 'object',
  required: ['floor'],
  additionalProperties: false,
  properties: {
    floor: FLOOR,
    startedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const completeFloorBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { completedAt: { type: 'string', format: 'date-time' } },
} as const;

/**
 * An observation: something recorded at a specific location and time.
 *
 * The location goes in as the components of the grammar
 * `Floor N — <qualifier>, <Side|Sector>` and never as the composed string,
 * which is rendered on read instead.
 *
 * `oneOf` is the whole of story 55 — "Side and Sector treated as independent
 * axes that never combine into one string". Both set matches neither branch;
 * neither set matches neither branch either, because the grammar has no
 * optional segment for an interface to leave empty. An explicit null is
 * refused too, by `pattern` rather than by `type`: ajv coerces it to the empty
 * string first, which `NOT_BLANK` then rejects. Same outcome, and it matters
 * because a null is what a form sends for a field nobody filled in, which must
 * never become a way of saying the other axis is the only one.
 *
 * The caps: what was observed gets the sheet list's 2000, being the other
 * field that holds more than a phrase — a minute of dictated speech is about
 * 900 characters, and issue #12 turns exactly that into this field. The
 * qualifier gets the project name's 200, being a phrase you say out loud. Both
 * axes get the floor's 32.
 */
const observationBodySchema = {
  type: 'object',
  required: ['observed', 'floor', 'qualifier'],
  additionalProperties: false,
  properties: {
    observed: { type: 'string', pattern: NOT_BLANK, maxLength: 2000 },
    // The stamp issue #11 bins photographs against, so it must be the real
    // moment and never the moment the row was written.
    observedAt: { type: 'string', format: 'date-time' },
    floor: FLOOR,
    // Free text across all five kinds of reference the glossary admits — a
    // landmark, a room number with a type gloss, a circulation element, a
    // program space, or an equipment tag (story 54).
    qualifier: { type: 'string', pattern: NOT_BLANK, maxLength: 200 },
    side: { type: 'string', pattern: NOT_BLANK, maxLength: 32 },
    sector: { type: 'string', pattern: NOT_BLANK, maxLength: 32 },
  },
  oneOf: [
    { required: ['side'], not: { required: ['sector'] } },
    { required: ['sector'], not: { required: ['side'] } },
  ],
} as const;

/** Which entry of a captured block a route is pointed at. */
const blockLineParamsSchema = {
  type: 'object',
  required: ['id', 'line'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    line: { type: 'integer', minimum: 0 },
  },
} as const;

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
function itemOnSubmission(
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

/** The one 404 body for assumption records, matching the others. */
function noSuchAssumptionRecord(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no assumption record with that id' });
}

/**
 * The verbatim entry a line number addresses, or why it addresses none.
 *
 * A block is captured verbatim and never edited, so a line number is a stable
 * pointer into it — which is what lets a counterfactual and a raised flag name
 * an entry without a second copy of its wording existing to disagree with the
 * block. Past the end is a 404, because the caller named a line that is not
 * there; a line with nothing on it is a 409, because the line exists and is
 * simply not an entry.
 *
 * Every non-blank line is an entry. The three calculators all write one
 * assumption or flag per line under a header, prefixed `- ` and `! `, but
 * those sigils are their convention and not a contract — reading them here
 * would make this refuse the next helper skill's output.
 */
function entryAt(
  block: string,
  line: number,
  named: 'assumptions' | 'flags',
): { text: string } | Refusal {
  const text = block.split('\n')[line];
  if (text === undefined) {
    return { code: 404, message: 'that block has no line with that number' };
  }
  if (!new RegExp(NOT_BLANK).test(text)) {
    return { code: 409, message: `that line of the ${named} block is blank` };
  }
  return { text };
}

/** The entries pointing into a record's blocks. */
const recordInclude = {
  counterfactuals: { select: { line: true, counterfactual: true } },
  raisedFlags: { select: { line: true, openItem: true } },
} as const;

type CapturedRecord = Prisma.AssumptionRecordGetPayload<{
  include: typeof recordInclude;
}>;

/**
 * A record on the wire: the blocks verbatim, plus each split into the entries
 * a line number addresses.
 *
 * The lines are derived on every read and stored nowhere, for the reason
 * *currently provisional* and *superseded* are (ADR-0027, ADR-0028). The
 * issuance is not joined: the record already names it by `submissionId`, and
 * two ways to read the same binding is the second place it can be wrong.
 */
function withLines(found: CapturedRecord) {
  const { counterfactuals, raisedFlags, ...record } = found;
  const written = new Map(
    counterfactuals.map((row) => [row.line, row.counterfactual]),
  );
  const raised = new Map(raisedFlags.map((row) => [row.line, row.openItem]));

  return {
    ...record,
    assumptionLines: record.assumptions.split('\n').map((text, line) => ({
      line,
      text,
      counterfactual: written.get(line) ?? null,
    })),
    flagLines: record.flags.split('\n').map((text, line) => ({
      line,
      text,
      openItem: raised.get(line) ?? null,
    })),
  };
}

/** The one 404 body for site visits, matching the others. */
function noSuchSiteVisit(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no site visit with that id' });
}

/**
 * The one end-before-start body. Said twice — once by the create route, once
 * by the end route — and a reworded message must not become two different
 * sentences, for the reason `alreadySuperseded` is one function.
 */
function endsBeforeItStarted(reply: FastifyReply) {
  return reply
    .code(409)
    .send({ message: 'a site visit cannot end before it started' });
}

/** The one 404 body for a floor's entry in a visit's schedule. */
function noSuchFloor(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no floor with that id' });
}

/**
 * A site visit on the wire, with the date it was.
 *
 * "One *dated* observation event" is the day the walk started, derived on
 * every read and stored nowhere — the shape ADR-0027 and ADR-0028 gave
 * *currently provisional* and *superseded*. A `visited_on` column would be a
 * second place for the same fact to be wrong, and the one place a visit could
 * come to be dated a different day from the one it started on.
 */
function withDate<T extends { startedAt: Date }>(visit: T) {
  return { ...visit, visitedOn: visit.startedAt.toISOString().slice(0, 10) };
}

/**
 * The location as the field says it: `Floor N — <qualifier>, <Side|Sector>`
 * (glossary, story 53).
 *
 * Composed on every read from the components and stored nowhere, so the parts
 * and the string cannot come to disagree. Exactly one axis is set — the body
 * schema and a CHECK constraint both say so — which is why there is no
 * conditional tail here: the grammar has no optional segment.
 *
 * The axis name is part of the segment rather than part of the stored value,
 * because Side and Sector are what the two axes *are*, and a column holding
 * "Side A" could be written with the wrong one.
 */
function renderLocation(observation: {
  floor: string;
  qualifier: string;
  side: string | null;
  sector: string | null;
}): string {
  const axis =
    observation.side === null
      ? `Sector ${observation.sector}`
      : `Side ${observation.side}`;
  return `Floor ${observation.floor} — ${observation.qualifier}, ${axis}`;
}

/** An observation on the wire: the components, and the string they render to. */
function withLocation<
  T extends {
    floor: string;
    qualifier: string;
    side: string | null;
    sector: string | null;
  },
>(observation: T) {
  return { ...observation, location: renderLocation(observation) };
}

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

/** The one 404 body for issues, matching the others. */
function noSuchIssue(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no issue with that id' });
}

/** The one 404 body for observations, matching the others. */
function noSuchObservation(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no observation with that id' });
}

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

// ── Photographs and the two bindings (issue #11) ─────────────────────────
//
// Above the issue helpers rather than at the bottom with the rest of the
// slice, because an issue is read with its photo evidence and `issueInclude`
// names `photoInclude` below.

/**
 * The image types the boundary admits, byte-exact and closed.
 *
 * Closed rather than any `image/*`, because the read route hands this value
 * straight back as the response's content type: a row carrying `text/html`
 * would be a page this product served under its own origin. A CHECK
 * constraint names the same four underneath, the way the issue category's
 * five are named in both places.
 */
const PHOTO_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/webp',
] as const;

/**
 * Twelve mebibytes of file, as the base64 that carries it.
 *
 * The cap the plan does not state. A 48-megapixel HEIC off a current phone is
 * about five, and the largest JPEG a site camera produces is under ten, so
 * twelve is the first round number above anything a walk actually generates.
 */
const PHOTO_BYTES_MAX = 16_777_216;

/** The body plus its JSON, so the limit refuses a file and not a request. */
const PHOTO_BODY_LIMIT = PHOTO_BYTES_MAX + 64 * 1024;

/**
 * A photograph on the way in.
 *
 * The bytes arrive base64 in the JSON body rather than as multipart, so the
 * filename, the timestamp and the type are refused by the same schema as
 * every other field in this product instead of by a hand-written check on the
 * far side of a plugin. The cost is a third more on the wire, and it buys a
 * boundary that behaves like all the others.
 *
 * `takenAt` is required, and pointedly does not fall back to the injected
 * clock the way `observedAt` does: a photograph with no time would bin to
 * whichever floor was being walked at the moment of the request, which is the
 * guess the ticket asks not to make.
 */
const photoBodySchema = {
  type: 'object',
  required: ['filename', 'takenAt', 'contentType', 'bytes'],
  additionalProperties: false,
  properties: {
    // Long enough for a real name off a phone, which is the mechanism, and
    // short enough to be a filename rather than a sentence.
    filename: { type: 'string', pattern: NOT_BLANK, maxLength: 255 },
    takenAt: { type: 'string', format: 'date-time' },
    contentType: { type: 'string', enum: [...PHOTO_CONTENT_TYPES] },
    // Four characters of base64 is one byte or more, so a body that passes
    // here can never decode to the nothing the CHECK constraint refuses.
    bytes: {
      type: 'string',
      pattern: '^[A-Za-z0-9+/]+={0,2}$',
      minLength: 4,
      maxLength: PHOTO_BYTES_MAX,
    },
  },
} as const;

/**
 * Correcting the floor. Null clears it, which is a real answer: the engineer
 * saying "not this floor" and the schedule saying nothing are the same fact
 * about where the photograph belongs.
 */
const photoFloorBodySchema = {
  type: 'object',
  required: ['floor'],
  additionalProperties: false,
  properties: { floor: { oneOf: [FLOOR, { type: 'null' }] } },
} as const;

/** Correcting the finding, by the identifier rather than by the row id. */
const photoIssueBodySchema = {
  type: 'object',
  required: ['issueNumber'],
  additionalProperties: false,
  properties: {
    issueNumber: { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
  },
} as const;

/** The one 404 body for photographs, matching the others. */
function noSuchPhoto(reply: FastifyReply) {
  return reply.code(404).send({ message: 'no photo with that id' });
}

const photoInclude = { issue: { select: { number: true } } } as const;

type StoredPhoto = Prisma.PhotoGetPayload<{ include: typeof photoInclude }>;

/**
 * A photograph on the wire: the **identifier** of the finding it evidences,
 * and neither that finding's row id nor the key its bytes are under.
 *
 * The number, because the identifier is the thing anybody has written down —
 * it is what the filename carried in and what the report will print. The
 * storage key is the object store's business and means something different
 * the day the adapter changes.
 */
function photoOnTheWire(photo: StoredPhoto) {
  const { storageKey: _key, issueId: _row, issue, ...onTheWire } = photo;
  return { ...onTheWire, issueNumber: issue === null ? null : issue.number };
}

/**
 * The floor whose window contains the moment a photograph was taken, or null
 * (story 63).
 *
 * A window runs from when the floor was started to when it was completed,
 * **both ends included**, and stays open while the floor is still being
 * walked: the last floor of a walk is the one most often left unclosed, and a
 * photograph taken on it is not ambiguous just because nobody said "done".
 *
 * **Exactly one window, or nothing.** None is the case the ticket names by
 * hand. Two is the walk where the engineer doubled back before closing a
 * floor — both windows really do contain the moment, so which floor it was
 * taken on is not known, and picking one would be the same guess.
 */
function binToFloor(
  takenAt: Date,
  schedule: { floor: string; startedAt: Date; completedAt: Date | null }[],
): string | null {
  const taken = takenAt.getTime();
  const containing = schedule.filter(
    (window) =>
      window.startedAt.getTime() <= taken &&
      (window.completedAt === null || taken <= window.completedAt.getTime()),
  );
  return containing.length === 1 ? (containing[0]?.floor ?? null) : null;
}

/**
 * The grammar the engineer already uses, written down here for the first time
 * (story 64): `issue` or `iss`, then the number, with a hyphen, an underscore,
 * a space or nothing between them — `3-west stair-issue-12.jpg`,
 * `B1 MDP room ISS-7.jpeg`.
 *
 * [[0018]] records that photographs "already arrive over a messaging app with
 * filenames encoding floor, location, and issue" and says no more than that;
 * [[0031]] refused to invent the rest without having seen a real name.
 * ADR-0032 is where a real one was supplied, and this is it.
 *
 * **A marker is required and a bare integer never counts.** `IMG_0003.jpg`
 * names no finding — it is a camera's counter, and reading it as issue 3
 * would have the mechanism doing harm to most of a hundred photographs, which
 * is worse than binding none of them.
 *
 * The floor the ADR also mentions is deliberately not read here: the timestamp
 * against the schedule is the floor's mechanism, and two answers to one
 * question is a disagreement waiting to be resolved by a coin.
 */
const ISSUE_IN_FILENAME = /\b(?:issue|iss)[-_ ]?(\d+)/gi;

/**
 * One distinct identifier or nothing, for the reason a floor takes exactly one
 * window: a name carrying two findings does not say which the photograph is
 * of. The same one twice is still one.
 */
function issueNumberInFilename(filename: string): number | null {
  const named = new Set(
    [...filename.matchAll(ISSUE_IN_FILENAME)].map((match) => Number(match[1])),
  );
  const [only] = named;
  return named.size === 1 ? (only ?? null) : null;
}

/**
 * What an issue is read with: every sighting of it, oldest first, and the open
 * items being chased for it.
 *
 * The sightings come back in the order they were made rather than the order
 * they were attached, because they are a chronicle across walks — "still there
 * on the second walk" is read down the list.
 */
const issueInclude = {
  observations: {
    orderBy: [
      { observation: { observedAt: 'asc' } },
      { observation: { createdAt: 'asc' } },
    ],
    select: {
      observation: {
        include: {
          siteVisit: { select: { id: true, startedAt: true, endedAt: true } },
        },
      },
    },
  },
  openItems: {
    orderBy: { openItem: { waitingSince: 'asc' } },
    select: { openItem: true },
  },
  // The photo evidence for this finding, across every walk it was seen on
  // (issue #11). A list, whose length is the count.
  photos: {
    orderBy: [{ takenAt: 'asc' }, { createdAt: 'asc' }],
    include: photoInclude,
  },
  // `satisfies` rather than `as const`, which the other includes here use:
  // Prisma's `orderBy` takes a mutable array, and `as const` makes this one
  // readonly.
} satisfies Prisma.IssueInclude;

type Finding = Prisma.IssueGetPayload<{ include: typeof issueInclude }>;

/**
 * An issue on the wire: the sightings across every walk it was seen on, and
 * what is being chased for it.
 *
 * The location comes off each sighting and is rendered there, not here. The
 * PRD's sketch put a `location` on the issue; an issue re-observed on three
 * walks has three of them, and one column would have to pick a walk and be
 * silently wrong about the others.
 */
function withSightings(found: Finding) {
  const { observations, openItems, photos, ...issue } = found;
  return {
    ...issue,
    observations: observations.map(({ observation }) => {
      const { siteVisit, ...sighting } = observation;
      return { ...withLocation(sighting), siteVisit: withDate(siteVisit) };
    }),
    openItems: openItems.map((row) => row.openItem),
    photos: photos.map(photoOnTheWire),
  };
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

export function buildServer({
  prisma,
  queue,
  objectStore,
  timeSource = systemTimeSource,
  logger = false,
}: ServerDependencies): FastifyInstance {
  const app = Fastify({
    logger,
    // Fastify's ajv defaults to `removeAdditional: true`, which silently
    // strips an unknown field instead of failing the request. A body carrying
    // `owner` would then look accepted while the field vanished — so
    // `additionalProperties: false` is made to mean what it says.
    ajv: { customOptions: { removeAdditional: false } },
  });

  app.register(
    async (v1) => {
      /**
       * 200 means PostgreSQL and the queue's Redis both answered; either
       * failing rejects and Fastify returns 500. The body carries only what
       * varies, so there is nothing here that reads as a status but can never
       * be anything other than "ok".
       */
      v1.get('/health', async () => {
        const [, jobs] = await Promise.all([
          prisma.$queryRaw`SELECT 1`,
          queue.getJobCounts('waiting', 'active'),
        ]);

        return {
          queue: { name: queue.name, ...jobs },
          now: timeSource.now().toISOString(),
        };
      });

      v1.post<{ Body: { projectNumber: string; name: string } }>(
        '/projects',
        { schema: { body: projectBodySchema } },
        async (request, reply) => {
          try {
            const project = await prisma.project.create({
              data: { ...request.body, createdAt: timeSource.now() },
            });
            return reply.code(201).send(projectOnTheWire(project));
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
          ).map(projectOnTheWire),
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
            : projectOnTheWire(project);
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
            : projectOnTheWire(project);
        },
      );

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

      /**
       * Phases are rows on a project, never an enum: some jobs run 50% CD and
       * others go straight to 90% CD, so there is no set to share across them
       * (ADR-0015). A new one lands at the end of the list.
       */
      v1.post<{ Params: { id: string }; Body: { name: string } }>(
        '/projects/:id/phases',
        { schema: { body: phaseBodySchema } },
        async (request, reply) => {
          const project = await prisma.project.findUnique({
            where: { id: request.params.id },
            select: { id: true },
          });
          if (project === null) {
            return noSuchProject(reply);
          }

          try {
            const phase = await prisma.projectPhase.create({
              data: {
                projectId: project.id,
                name: request.body.name,
                position: await prisma.projectPhase.count({
                  where: { projectId: project.id },
                }),
              },
            });
            return reply.code(201).send(phase);
          } catch (error) {
            if (isUniqueViolation(error)) {
              return reply
                .code(409)
                .send({ message: 'that phase name is already on this project' });
            }
            throw error;
          }
        },
      );

      v1.get<{ Params: { id: string } }>(
        '/projects/:id/phases',
        async (request, reply) => {
          const project = await prisma.project.findUnique({
            where: { id: request.params.id },
            select: { id: true },
          });
          if (project === null) {
            return noSuchProject(reply);
          }

          return prisma.projectPhase.findMany({
            where: { projectId: project.id },
            orderBy: { position: 'asc' },
          });
        },
      );

      /**
       * Renaming propagates to every submission issued at this phase, because
       * a rename is the same body of work under a better name. A set that
       * went out at a different stage is a different phase (ADR-0026).
       */
      v1.post<{ Params: { id: string }; Body: { name: string } }>(
        '/phases/:id/rename',
        { schema: { body: phaseBodySchema } },
        async (request, reply) => {
          const { id } = request.params;
          const phase = await prisma.projectPhase.findUnique({ where: { id } });
          if (phase === null) {
            return noSuchPhase(reply);
          }

          try {
            return await prisma.projectPhase.update({
              where: { id },
              data: { name: request.body.name },
            });
          } catch (error) {
            if (isUniqueViolation(error)) {
              return reply
                .code(409)
                .send({ message: 'that phase name is already on this project' });
            }
            throw error;
          }
        },
      );

      /**
       * The whole ordered list, or nothing. A partial list would silently
       * leave a phase at a stale position and a repeated id would give two
       * phases the same place, so both are refused rather than absorbed.
       */
      v1.post<{ Params: { id: string }; Body: { phaseIds: string[] } }>(
        '/projects/:id/phases/order',
        { schema: { body: phaseOrderBodySchema } },
        async (request, reply) => {
          const project = await prisma.project.findUnique({
            where: { id: request.params.id },
            select: { id: true },
          });
          if (project === null) {
            return noSuchProject(reply);
          }

          const { phaseIds } = request.body;
          const existing = await prisma.projectPhase.findMany({
            where: { projectId: project.id },
            select: { id: true },
          });
          const known = new Set(existing.map((phase) => phase.id));
          const named = new Set(phaseIds);
          if (
            named.size !== phaseIds.length ||
            named.size !== known.size ||
            phaseIds.some((phaseId) => !known.has(phaseId))
          ) {
            return reply.code(409).send({
              message: "an order must name exactly this project's phases, once each",
            });
          }

          await prisma.$transaction(
            phaseIds.map((phaseId, position) =>
              prisma.projectPhase.update({
                where: { id: phaseId },
                data: { position },
              }),
            ),
          );

          return prisma.projectPhase.findMany({
            where: { projectId: project.id },
            orderBy: { position: 'asc' },
          });
        },
      );

      /**
       * The first route that updates a project. The project *number* is what
       * the glossary makes immutable, and it still is — this writes the phase
       * a new submission defaults to (ADR-0026).
       */
      v1.post<{ Params: { id: string }; Body: { phaseId: string } }>(
        '/projects/:id/current-phase',
        { schema: { body: currentPhaseBodySchema } },
        async (request, reply) => {
          const { id } = request.params;
          const project = await prisma.project.findUnique({
            where: { id },
            select: { id: true },
          });
          if (project === null) {
            return noSuchProject(reply);
          }

          const badPhase = await phaseRefusal(
            prisma,
            request.body.phaseId,
            project.id,
          );
          if (badPhase !== null) {
            return refuse(reply, badPhase);
          }

          return projectOnTheWire(
            await prisma.project.update({
              where: { id },
              data: { currentPhaseId: request.body.phaseId },
            }),
          );
        },
      );

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

      /**
       * Capturing what a helper skill produced (issue #8, stories 36-38). The
       * two blocks go in verbatim — nothing here trims, normalises or re-wraps
       * them, and nothing here recomputes what they say.
       *
       * Bound to the submission it justified, which is the route it is
       * captured on. There is no route that updates one and none that deletes
       * one, for the reason a submission has neither: it is a capture of what
       * something else output at a moment. Running the calculation again is
       * another record against the same issuance, dated its own day.
       */
      v1.post<{
        Params: { id: string };
        Body: {
          assumptions: string;
          flags: string;
          codeEdition: string;
          calculatedAt?: string;
        };
      }>(
        '/submissions/:id/assumption-records',
        { schema: { body: assumptionRecordBodySchema } },
        async (request, reply) => {
          const set = await prisma.submission.findUnique({
            where: { id: request.params.id },
            select: { id: true },
          });
          if (set === null) {
            return noSuchSubmission(reply);
          }

          const { calculatedAt, ...rest } = request.body;
          const record = await prisma.assumptionRecord.create({
            data: {
              ...rest,
              submissionId: set.id,
              calculatedAt: instant(calculatedAt, timeSource),
              createdAt: timeSource.now(),
            },
            include: recordInclude,
          });
          return reply.code(201).send(withLines(record));
        },
      );

      /**
       * What was assumed when this went out (story 37), oldest calculation
       * first. Entry order breaks a tie, so two captures dated the same day do
       * not come back in an arbitrary one.
       */
      v1.get<{ Params: { id: string } }>(
        '/submissions/:id/assumption-records',
        async (request, reply) => {
          const set = await prisma.submission.findUnique({
            where: { id: request.params.id },
            select: { id: true },
          });
          if (set === null) {
            return noSuchSubmission(reply);
          }

          const listed = await prisma.assumptionRecord.findMany({
            where: { submissionId: set.id },
            orderBy: [{ calculatedAt: 'asc' }, { createdAt: 'asc' }],
            include: recordInclude,
          });
          return listed.map(withLines);
        },
      );

      /**
       * What changes if one assumed input turns out wrong (story 39). Written
       * against the line of the `ASSUMPTIONS` block it is about, so the
       * durable artifact is the reasoning and not a paragraph beside the
       * arithmetic.
       *
       * A second one on the same input is refused rather than repeated,
       * matching the resolve rule: a silent overwrite would lose the first
       * reading of a consequence, which is the part worth keeping.
       */
      v1.post<{
        Params: { id: string; line: number };
        Body: { counterfactual: string };
      }>(
        '/assumption-records/:id/assumptions/:line/counterfactual',
        {
          schema: {
            params: blockLineParamsSchema,
            body: counterfactualBodySchema,
          },
        },
        async (request, reply) => {
          const { id, line } = request.params;
          const record = await prisma.assumptionRecord.findUnique({
            where: { id },
            select: { assumptions: true },
          });
          if (record === null) {
            return noSuchAssumptionRecord(reply);
          }

          const entry = entryAt(record.assumptions, line, 'assumptions');
          if ('code' in entry) {
            return refuse(reply, entry);
          }

          try {
            const written = await prisma.counterfactual.create({
              data: {
                assumptionRecordId: id,
                line,
                counterfactual: request.body.counterfactual,
              },
              select: { line: true, counterfactual: true },
            });
            return reply.code(201).send(written);
          } catch (error) {
            // The composite key, and the only constraint this insert touches.
            if (isUniqueViolation(error)) {
              return reply.code(409).send({
                message: 'that assumed input already carries a counterfactual',
              });
            }
            throw error;
          }
        },
      );

      /**
       * A flag raised as an open item (story 40), so a flag raised during a
       * calculation cannot be raised and then forgotten.
       *
       * The item lands on the project and is attached to the submission the
       * record justified — the subject stays `PROJECT` (ADR-0026), because an
       * item that vanished from the project screen the moment it was tied to a
       * set would be the opposite of "nothing sitting in my court".
       *
       * It is attached *after* the issuance, so it is no part of what went out:
       * it makes the set currently provisional and puts it into exposure, and
       * leaves `issued_provisional` exactly as it was stamped (ADR-0027).
       */
      v1.post<{
        Params: { id: string; line: number };
        Body: {
          unresolved?: string;
          blocks: string;
          waitingOn: string | null;
          waitingSince?: string;
          invalidationTrigger?: string;
          counterfactual: string;
          owner?: string;
        };
      }>(
        '/assumption-records/:id/flags/:line/open-item',
        {
          schema: { params: blockLineParamsSchema, body: raisedFlagBodySchema },
        },
        async (request, reply) => {
          const { id, line } = request.params;
          const record = await prisma.assumptionRecord.findUnique({
            where: { id },
            select: {
              flags: true,
              submission: { select: { id: true, projectId: true } },
            },
          });
          if (record === null) {
            return noSuchAssumptionRecord(reply);
          }

          const entry = entryAt(record.flags, line, 'flags');
          if ('code' in entry) {
            return refuse(reply, entry);
          }

          const { unresolved, ...rest } = request.body;
          // Left off, the flag says what is unresolved in its own words —
          // which is the whole of "generate an open item directly from a
          // FLAGS / VERIFY entry". Only the surrounding whitespace goes: the
          // sigil the calculators prefix stays, because stripping it would be
          // this reading a format it has no contract with.
          const wording = unresolved ?? entry.text.trim();
          if (wording.length > UNRESOLVED_MAX) {
            return reply.code(409).send({
              message:
                'that flag is too long to become an open item on its own; say what is unresolved',
            });
          }

          try {
            const item = await prisma.$transaction(async (tx) => {
              const created = await tx.openItem.create({
                data: itemOnSubmission(
                  rest,
                  record.submission,
                  wording,
                  timeSource,
                ),
              });
              await tx.raisedFlag.create({
                data: { assumptionRecordId: id, line, openItemId: created.id },
              });
              return created;
            });
            return reply.code(201).send(item);
          } catch (error) {
            // Unqualified, and safe to be: every other row this transaction
            // writes carries a freshly generated id, so `raised_flags` is the
            // only constraint in it that anything can collide with. The
            // transaction rolls back, so a refused second raise leaves no open
            // item behind.
            if (isUniqueViolation(error)) {
              return reply.code(409).send({
                message: 'that flag has already been raised as an open item',
              });
            }
            throw error;
          }
        },
      );

      // ── Site visits and observations (issue #9) ──────────────────────────

      /**
       * Recording a walk. One dated observation event against a building: it
       * produces observations and does not own their content.
       *
       * The end may be left off, because the per-floor schedule is recorded
       * during the visit (story 50) and a walk therefore has to be able to
       * exist before it is over.
       */
      v1.post<{
        Params: { id: string };
        Body: { startedAt?: string; endedAt?: string };
      }>(
        '/projects/:id/site-visits',
        { schema: { body: siteVisitBodySchema } },
        async (request, reply) => {
          const project = await prisma.project.findUnique({
            where: { id: request.params.id },
            select: { id: true },
          });
          if (project === null) {
            return noSuchProject(reply);
          }

          const { startedAt, endedAt } = request.body;
          const started = instant(startedAt, timeSource);
          const ended = endedAt === undefined ? null : new Date(endedAt);
          if (ended !== null && ended < started) {
            return endsBeforeItStarted(reply);
          }

          const created = await prisma.siteVisit.create({
            data: {
              projectId: project.id,
              startedAt: started,
              endedAt: ended,
              createdAt: timeSource.now(),
            },
          });
          return reply.code(201).send(withDate(created));
        },
      );

      /** Oldest first: this screen is a chronicle of the walks on a job. */
      v1.get<{ Params: { id: string } }>(
        '/projects/:id/site-visits',
        async (request, reply) => {
          const project = await prisma.project.findUnique({
            where: { id: request.params.id },
            select: { id: true },
          });
          if (project === null) {
            return noSuchProject(reply);
          }

          const listed = await prisma.siteVisit.findMany({
            where: { projectId: project.id },
            orderBy: [{ startedAt: 'asc' }, { createdAt: 'asc' }],
          });
          return listed.map(withDate);
        },
      );

      /**
       * One visit, with the job it was against, the per-floor schedule and
       * what it produced.
       *
       * The floors come back in the order they were walked and the
       * observations in the order they were made, because both are chronicles
       * of one afternoon and entry order is not what either is about.
       */
      v1.get<{ Params: { id: string } }>(
        '/site-visits/:id',
        async (request, reply) => {
          const found = await prisma.siteVisit.findUnique({
            where: { id: request.params.id },
            include: {
              project: {
                select: { id: true, projectNumber: true, name: true },
              },
              floors: { orderBy: { startedAt: 'asc' } },
              observations: {
                orderBy: [{ observedAt: 'asc' }, { createdAt: 'asc' }],
              },
              photos: {
                orderBy: [{ takenAt: 'asc' }, { createdAt: 'asc' }],
                include: photoInclude,
              },
            },
          });
          if (found === null) {
            return noSuchSiteVisit(reply);
          }

          const { observations, photos, ...visit } = found;
          return {
            ...withDate(visit),
            observations: observations.map(withLocation),
            photos: photos.map(photoOnTheWire),
          };
        },
      );

      /**
       * The walk is over. Stamped once and never restamped, for the reason
       * archiving a project is: a second stamp would silently move when a
       * visit ended, and the schedule under it is what issue #11 bins
       * photographs against.
       */
      v1.post<{ Params: { id: string }; Body: { endedAt?: string } }>(
        '/site-visits/:id/end',
        { schema: { body: endVisitBodySchema } },
        async (request, reply) => {
          const walk = await prisma.siteVisit.findUnique({
            where: { id: request.params.id },
            select: { id: true, startedAt: true, endedAt: true },
          });
          if (walk === null) {
            return noSuchSiteVisit(reply);
          }
          if (walk.endedAt !== null) {
            return reply
              .code(409)
              .send({ message: 'that site visit has already ended' });
          }

          const ended = instant(request.body.endedAt, timeSource);
          if (ended < walk.startedAt) {
            return endsBeforeItStarted(reply);
          }

          const updated = await prisma.siteVisit.update({
            where: { id: walk.id },
            data: { endedAt: ended },
          });
          return withDate(updated);
        },
      );

      /**
       * Arriving on a floor (story 50). One row per floor per visit, so that
       * every photograph taken between this stamp and the completion below can
       * be attributed to the floor without being labelled by hand (issue #11).
       */
      v1.post<{
        Params: { id: string };
        Body: { floor: string; startedAt?: string };
      }>(
        '/site-visits/:id/floors',
        { schema: { body: startFloorBodySchema } },
        async (request, reply) => {
          const walk = await prisma.siteVisit.findUnique({
            where: { id: request.params.id },
            select: { id: true },
          });
          if (walk === null) {
            return noSuchSiteVisit(reply);
          }

          try {
            const created = await prisma.siteVisitFloor.create({
              data: {
                siteVisitId: walk.id,
                floor: request.body.floor,
                startedAt: instant(request.body.startedAt, timeSource),
              },
            });
            return reply.code(201).send(created);
          } catch (error) {
            // The unique constraint is what refuses a floor started twice on
            // one walk, rather than a guard that can be forgotten. Unqualified,
            // and safe to be: it is the only constraint this insert can hit.
            if (isUniqueViolation(error)) {
              return reply.code(409).send({
                message: 'that floor is already on this site visit’s schedule',
              });
            }
            throw error;
          }
        },
      );

      /**
       * Leaving a floor. Addressed by the schedule row's own id rather than by
       * the designation, which is free text and would have to survive being
       * put in a path.
       */
      v1.post<{ Params: { id: string }; Body: { completedAt?: string } }>(
        '/site-visit-floors/:id/complete',
        { schema: { body: completeFloorBodySchema } },
        async (request, reply) => {
          const floor = await prisma.siteVisitFloor.findUnique({
            where: { id: request.params.id },
            select: { id: true, startedAt: true, completedAt: true },
          });
          if (floor === null) {
            return noSuchFloor(reply);
          }
          if (floor.completedAt !== null) {
            return reply
              .code(409)
              .send({ message: 'that floor is already completed' });
          }

          const completed = instant(request.body.completedAt, timeSource);
          if (completed < floor.startedAt) {
            // A window that closed before it opened would bin every photograph
            // on the walk to nothing at all (issue #11).
            return reply.code(409).send({
              message: 'a floor cannot be completed before it was started',
            });
          }

          return prisma.siteVisitFloor.update({
            where: { id: floor.id },
            data: { completedAt: completed },
          });
        },
      );

      /**
       * Recording an observation (stories 53-56).
       *
       * It stays an observation. There is no status on it, no category and no
       * promotion: the "Notable Observations (Non-Issues)" table is the
       * majority case, so this is the default path and becoming an **issue** is
       * ticket #10's deliberate exception, arriving as a row that points here.
       *
       * The location goes in as components and the grammar string is rendered
       * on the way out. Exactly one of side or sector is set, which the body
       * schema refuses to let the interface get wrong.
       */
      v1.post<{
        Params: { id: string };
        Body: {
          observed: string;
          observedAt?: string;
          floor: string;
          qualifier: string;
          side?: string;
          sector?: string;
        };
      }>(
        '/site-visits/:id/observations',
        { schema: { body: observationBodySchema } },
        async (request, reply) => {
          const walk = await prisma.siteVisit.findUnique({
            where: { id: request.params.id },
            select: { id: true },
          });
          if (walk === null) {
            return noSuchSiteVisit(reply);
          }

          const { observedAt, side, sector, ...rest } = request.body;
          const created = await prisma.observation.create({
            data: {
              ...rest,
              siteVisitId: walk.id,
              observedAt: instant(observedAt, timeSource),
              side: side ?? null,
              sector: sector ?? null,
              createdAt: timeSource.now(),
            },
          });
          return reply.code(201).send(withLocation(created));
        },
      );

      // ── Issues with stable per-project identifiers (issue #10) ───────────

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

      /**
       * Adding a photograph to a walk (stories 63-64).
       *
       * Two independent mechanisms, both deterministic, both stamped here and
       * both correctable below. The timestamp against the per-floor schedule
       * binds it to a floor; the filename grammar binds it to a finding. It
       * may end up with either, both, or neither.
       *
       * Stamped rather than derived on every read, which is what this product
       * does with `location`, *currently provisional* and *superseded*: a
       * derived binding has nowhere to keep a correction, and a schedule fixed
       * the next morning would silently move what was already binned.
       *
       * Binning runs here and not on the queue. The PRD's diagram and the
       * spec's stack line both put photo binning on a worker; it is date and
       * string matching that takes microseconds, and a job would add
       * asynchrony, a progress surface and a second place to look for nothing.
       */
      v1.post<{
        Params: { id: string };
        Body: {
          filename: string;
          takenAt: string;
          contentType: string;
          bytes: string;
        };
      }>(
        '/site-visits/:id/photos',
        { schema: { body: photoBodySchema }, bodyLimit: PHOTO_BODY_LIMIT },
        async (request, reply) => {
          const walk = await prisma.siteVisit.findUnique({
            where: { id: request.params.id },
            select: {
              id: true,
              projectId: true,
              floors: {
                select: { floor: true, startedAt: true, completedAt: true },
              },
            },
          });
          if (walk === null) {
            return noSuchSiteVisit(reply);
          }

          const { filename, contentType } = request.body;
          const bytes = Buffer.from(request.body.bytes, 'base64');
          const takenAt = new Date(request.body.takenAt);

          // The identifier is the job's, so a name carrying a number this
          // project never allocated binds to nothing — including one that is
          // a real finding on some other job.
          const named = issueNumberInFilename(filename);
          const finding =
            named === null
              ? null
              : await prisma.issue.findUnique({
                  where: {
                    projectId_number: {
                      projectId: walk.projectId,
                      number: named,
                    },
                  },
                  select: { id: true },
                });

          try {
            const stored = await prisma.$transaction(async (tx) => {
              const row = await tx.photo.create({
                data: {
                  siteVisitId: walk.id,
                  filename,
                  takenAt,
                  contentType,
                  byteSize: bytes.byteLength,
                  storageKey: `photos/${randomUUID()}`,
                  floor: binToFloor(takenAt, walk.floors),
                  issueId: finding === null ? null : finding.id,
                  createdAt: timeSource.now(),
                },
                include: photoInclude,
              });

              // Inside the transaction, so a store that refuses the bytes
              // rolls the row back rather than leaving a photograph with
              // nothing behind it.
              await objectStore.put(row.storageKey, bytes, row.contentType);
              return row;
            });
            return reply.code(201).send(photoOnTheWire(stored));
          } catch (error) {
            // Narrowed to the name. The insert also writes a fresh storage
            // key, and answering "already on this visit" to a collision there
            // would be a lie at the one moment anybody read it.
            if (violates(error, 'filename')) {
              return reply
                .code(409)
                .send({ message: 'that file is already on this site visit' });
            }
            throw error;
          }
        },
      );

      /**
       * The bytes themselves, served through the API.
       *
       * Not a presigned URL. [[0020]] puts one shared secret in front of every
       * route and carved out exactly one exception, reasoning about it
       * explicitly; a second carve-out deserves the same treatment, and that
       * ADR is still Proposed.
       */
      v1.get<{ Params: { id: string } }>(
        '/photos/:id/bytes',
        async (request, reply) => {
          const found = await prisma.photo.findUnique({
            where: { id: request.params.id },
            select: { storageKey: true, contentType: true },
          });
          if (found === null) {
            return noSuchPhoto(reply);
          }

          const bytes = await objectStore.get(found.storageKey);
          return reply
            .header('content-type', found.contentType)
            // One of four image types, and the browser is told not to look
            // for a fifth.
            .header('x-content-type-options', 'nosniff')
            .send(bytes);
        },
      );

      /**
       * Correcting the floor in one action (story 65), which is the quality
       * bar [[0025]] holds this ticket to.
       *
       * The designation and not a row on the schedule: [[0030]] joined those
       * two by value on purpose, and a photograph belongs on a floor whether
       * or not anybody formally started it.
       */
      v1.post<{ Params: { id: string }; Body: { floor: string | null } }>(
        '/photos/:id/floor',
        { schema: { body: photoFloorBodySchema } },
        async (request, reply) => {
          const found = await prisma.photo.findUnique({
            where: { id: request.params.id },
            select: { id: true },
          });
          if (found === null) {
            return noSuchPhoto(reply);
          }

          const corrected = await prisma.photo.update({
            where: { id: found.id },
            data: { floor: request.body.floor },
            include: photoInclude,
          });
          return photoOnTheWire(corrected);
        },
      );

      /**
       * Correcting the finding in one action (story 65), by the identifier.
       *
       * Independent of the floor above, because the two mechanisms are: a
       * photograph binned to the wrong floor and bound to the right finding
       * needs one of them fixed and not both restated.
       */
      v1.post<{ Params: { id: string }; Body: { issueNumber: number | null } }>(
        '/photos/:id/issue',
        { schema: { body: photoIssueBodySchema } },
        async (request, reply) => {
          const found = await prisma.photo.findUnique({
            where: { id: request.params.id },
            select: { id: true, siteVisit: { select: { projectId: true } } },
          });
          if (found === null) {
            return noSuchPhoto(reply);
          }

          const { issueNumber } = request.body;
          let issueId: string | null = null;
          if (issueNumber !== null) {
            // Resolved against this job, so another project's issue 1 is not
            // an issue this photograph can evidence — the same answer the
            // filename gets, and for the same reason.
            const finding = await prisma.issue.findUnique({
              where: {
                projectId_number: {
                  projectId: found.siteVisit.projectId,
                  number: issueNumber,
                },
              },
              select: { id: true },
            });
            if (finding === null) {
              return reply
                .code(404)
                .send({ message: 'no issue with that number on this project' });
            }
            issueId = finding.id;
          }

          const corrected = await prisma.photo.update({
            where: { id: found.id },
            data: { issueId },
            include: photoInclude,
          });
          return photoOnTheWire(corrected);
        },
      );

      /**
       * Which findings on this walk still have no photo evidence (story 66),
       * read before the report is generated so it never ships with
       * placeholders.
       *
       * A **list**, whose length is the count — [[0027]]'s shape, so a number
       * on a screen and the records it links to cannot disagree, and there is
       * no third figure to combine with the two [[0016]] keeps apart.
       *
       * "On this walk" is *sighted* on it: a finding with an observation made
       * here. And the evidence has to be from here too — July's photograph
       * does not evidence August's re-observation, and the report about to be
       * written is August's.
       */
      v1.get<{ Params: { id: string } }>(
        '/site-visits/:id/issues-without-photos',
        async (request, reply) => {
          const { id } = request.params;
          const walk = await prisma.siteVisit.findUnique({
            where: { id },
            select: { id: true },
          });
          if (walk === null) {
            return noSuchSiteVisit(reply);
          }

          const found = await prisma.issue.findMany({
            where: {
              observations: { some: { observation: { siteVisitId: id } } },
              photos: { none: { siteVisitId: id } },
            },
            orderBy: { number: 'asc' },
            include: issueInclude,
          });
          return found.map(withSightings);
        },
      );
    },
    { prefix: API_PREFIX },
  );

  return app;
}
