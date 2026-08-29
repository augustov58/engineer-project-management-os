/** Site visits, the per-floor schedule, and observations (issue #9). */

import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  FLOOR,
  NOT_BLANK,
  type RouteDependencies,
  instant,
  isUniqueViolation,
} from '../http.js';
import {
  noSuchFloor,
  noSuchProject,
  noSuchSiteVisit,
} from '../refusals.js';
import {
  photoOnTheWire,
  photosTaken,
  reportOnTheWire,
  reportsMade,
  voiceCaptureOnTheWire,
  voiceCapturesMade,
  withDate,
  withLocation,
} from '../wire.js';

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
export const observationBodySchema = {
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

/** What the schema above admits, for the two routes that write this table. */
export interface ObservationBody {
  observed: string;
  observedAt?: string;
  floor: string;
  qualifier: string;
  side?: string;
  sector?: string;
}

/**
 * An observation row, from the body every writer of this table validates
 * against the schema above.
 *
 * Exported because a second route writes observations now: issue #12 commits
 * one from a corrected transcript. ADR-0030 predicted exactly that and named
 * the risk — "story 55 is about the grammar not being corruptible *by the
 * interface*, which is exactly the guard a later writer forgets" — so the
 * schema and the row it becomes are one thing to reach for rather than two to
 * remember.
 *
 * The instant is a parameter and not read from a clock here, because the two
 * callers fall back to different ones: a typed observation to the injected
 * TimeSource, and one committed from a recording to the moment the recording
 * was made.
 */
export function observationData(
  body: ObservationBody,
  siteVisitId: string,
  observedAt: Date,
  createdAt: Date,
) {
  const { observedAt: _supplied, side, sector, ...rest } = body;
  return {
    ...rest,
    siteVisitId,
    observedAt,
    side: side ?? null,
    sector: sector ?? null,
    createdAt,
  };
}

/**
 * The one end-before-start body. Said twice — once by the create route, once
 * by the end route — and a reworded message must not become two different
 * sentences, for the reason `alreadySuperseded` is one function.
 */
export function endsBeforeItStarted(reply: FastifyReply) {
  return reply
    .code(409)
    .send({ message: 'a site visit cannot end before it started' });
}

export function siteVisitRoutes(
  v1: FastifyInstance,
  { prisma, timeSource }: RouteDependencies,
): void {
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
          photos: photosTaken,
          // What was spoken on this walk (issue #12), in the order it was
          // said. A recording still awaiting review is a draft and is not an
          // observation, so it is read here and not in the list above.
          voiceCaptures: voiceCapturesMade,
          // The write-ups asked for of this walk (issue #13), oldest first.
          // Here rather than on a list route of their own, because "the
          // generated report is retrievable from the visit" is the ticket's
          // criterion and this is the screen it is retrieved on.
          reports: reportsMade,
        },
      });
      if (found === null) {
        return noSuchSiteVisit(reply);
      }

      const { observations, photos, voiceCaptures, reports, ...visit } = found;
      return {
        ...withDate(visit),
        observations: observations.map(withLocation),
        photos: photos.map(photoOnTheWire),
        voiceCaptures: voiceCaptures.map(voiceCaptureOnTheWire),
        reports: reports.map(reportOnTheWire),
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
  v1.post<{ Params: { id: string }; Body: ObservationBody }>(
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

      const created = await prisma.observation.create({
        data: observationData(
          request.body,
          walk.id,
          instant(request.body.observedAt, timeSource),
          timeSource.now(),
        ),
      });
      return reply.code(201).send(withLocation(created));
    },
  );

}
