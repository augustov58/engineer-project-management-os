/** Photographs, and the two bindings each one is stamped with (issue #11). */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { FLOOR, NOT_BLANK, type RouteDependencies, violates } from '../http.js';
import { noSuchPhoto, noSuchSiteVisit } from '../refusals.js';
import {
  issueInclude,
  photoInclude,
  photoOnTheWire,
  withSightings,
} from '../wire.js';

/**
 * The largest value a Prisma `Int` column holds. An identifier above it is not
 * a number this product ever allocated, and passing it to a lookup is a driver
 * range error rather than a row that is not there.
 */
const MAX_IDENTIFIER = 2_147_483_647;

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
 * The longest base64 string the boundary takes, which is twelve mebibytes of
 * file. Named for the string because that is what `maxLength` measures.
 *
 * The cap the plan does not state. A 48-megapixel HEIC off a current phone is
 * about five, and the largest JPEG a site camera produces is under ten, so
 * twelve is the first round number above anything a walk actually generates.
 */
const PHOTO_BASE64_MAX = 16_777_216;

/** The body plus its JSON, so the limit refuses a file and not a request. */
const PHOTO_BODY_LIMIT = PHOTO_BASE64_MAX + 64 * 1024;

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
    // Strict base64: whole quartets, with the only short tail being the one
    // padding makes legal. The looser `[A-Za-z0-9+/]+={0,2}` this carried
    // until now admits a length of 4n+1, which is not base64 at all, and
    // which `Buffer.from` **silently truncates** rather than refusing — so a
    // short photograph would store and the route would answer 201, with
    // nothing downstream able to read it back against the original. ADR-0039
    // wrote this pattern for a document version and recorded that the fix
    // here belonged to a change about this record; this is that change.
    bytes: {
      type: 'string',
      pattern:
        '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$',
      minLength: 4,
      maxLength: PHOTO_BASE64_MAX,
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
    // Bounded above as well as below: an identifier is an `Int` column, and a
    // larger one is a range error from the driver where this route has its own
    // answer — no issue with that number on this project.
    issueNumber: {
      oneOf: [
        { type: 'integer', minimum: 1, maximum: MAX_IDENTIFIER },
        { type: 'null' },
      ],
    },
  },
} as const;

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
 *
 * The leading guard is a lookbehind for a letter and **not** `\b`, which is the
 * whole difference between this matching a real filename and not. `\b` counts
 * `_` as a word character, so `photo_issue_4.jpg` and `3_west_stair_iss_12.jpg`
 * — the underscore-joined shape a phone and a messaging app actually produce,
 * and the one this very grammar allows `iss_4` for on the other side of the
 * marker — would find no boundary before the marker and bind to nothing at all.
 * A *letter* is what must not precede it, so `dismissed-4`, `Missouri-3`,
 * `issuer-4` and `reissue-4` still name no finding.
 */
const ISSUE_IN_FILENAME = /(?<![a-z])(?:issue|iss)[-_ ]?(\d+)/gi;

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
  if (named.size !== 1 || only === undefined) {
    return null;
  }
  // An identifier is an `Int` column, so a longer run of digits is not a
  // number this job could ever have handed out — and asking anyway is a
  // driver error that would 500 the whole add and lose the photograph.
  // `ISS-20260723131500.jpg` is an ordinary name off a messaging app; it names
  // no finding, which is the same answer every other unmatched name gets.
  return only > MAX_IDENTIFIER ? null : only;
}

export function photoRoutes(
  v1: FastifyInstance,
  { prisma, objectStore, timeSource }: RouteDependencies,
): void {
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

      // The bytes go down first, under a key generated here, and the row
      // that points at them second. Never the other way round and never
      // both inside one transaction: a `put` against the S3 adapter
      // ADR-0032 promises is a network write, and holding a database
      // connection across it would blow Prisma's interactive-transaction
      // timeout on a large photograph and roll back a row whose object
      // was already stored.
      //
      // The cost is an orphaned object when the insert is refused —
      // garbage in the store, and nothing a reader can reach. The
      // alternative costs a row pointing at bytes that are not there,
      // which is the one a reader *does* reach.
      const storageKey = `photos/${randomUUID()}`;
      await objectStore.put(storageKey, bytes, contentType);

      try {
        const stored = await prisma.photo.create({
          data: {
            siteVisitId: walk.id,
            filename,
            takenAt,
            contentType,
            byteSize: bytes.byteLength,
            storageKey,
            floor: binToFloor(takenAt, walk.floors),
            issueId: finding === null ? null : finding.id,
            createdAt: timeSource.now(),
          },
          include: photoInclude,
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
}
