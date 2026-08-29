/**
 * The read shapes more than one record's routes return.
 *
 * Derived on every read and stored nowhere — the rule ADR-0027, ADR-0028,
 * ADR-0030 and ADR-0031 each recorded for a different column. A shape used by
 * exactly one record stays with that record; these are here because two do,
 * and a leaf is what stops `site-visits` and `photos` importing each other.
 */

import { Prisma, type SiteVisitReport } from '../generated/prisma/client.js';

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
export function projectOnTheWire<T extends { issuesAllocated: number }>(
  project: T,
) {
  const { issuesAllocated: _sequence, ...onTheWire } = project;
  return onTheWire;
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
export function withDate<T extends { startedAt: Date }>(visit: T) {
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
 *
 * Exported for the report (issue #13), which prints the same grammar onto the
 * page. There must be exactly one of it: two copies could drift, and "composed
 * on every read so the parts and the string cannot disagree" would then be
 * true of each copy and false of the pair.
 */
export function renderLocation(observation: {
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
export function withLocation<
  T extends {
    floor: string;
    qualifier: string;
    side: string | null;
    sector: string | null;
  },
>(observation: T) {
  return { ...observation, location: renderLocation(observation) };
}

export const photoInclude = { issue: { select: { number: true } } } as const;

/** A walk's photographs, and a finding's, in the order they were taken. */
export const photosTaken = {
  orderBy: [{ takenAt: 'asc' }, { createdAt: 'asc' }],
  include: photoInclude,
} satisfies Prisma.SiteVisit$photosArgs;

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
export function photoOnTheWire(photo: StoredPhoto) {
  const { storageKey: _key, issueId: _row, issue, ...onTheWire } = photo;
  return { ...onTheWire, issueNumber: issue === null ? null : issue.number };
}

/**
 * What an issue is read with: every sighting of it, oldest first, and the open
 * items being chased for it.
 *
 * The sightings come back in the order they were made rather than the order
 * they were attached, because they are a chronicle across walks — "still there
 * on the second walk" is read down the list.
 */
export const issueInclude = {
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
  photos: photosTaken,
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
export function withSightings(found: Finding) {
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
 * A recording read with the observation it became, if it became one.
 *
 * Here rather than in `routes/voice.ts` because two records return it: a walk
 * lists its recordings, and the voice routes return one. That is the same
 * reason `photoOnTheWire` is here (ADR-0033).
 */
export const voiceCapturesMade = {
  orderBy: [{ recordedAt: 'asc' }, { createdAt: 'asc' }],
  include: { observation: true },
} satisfies Prisma.SiteVisit$voiceCapturesArgs;

type StoredCapture = Prisma.VoiceCaptureGetPayload<{
  include: { observation: true };
}>;

/**
 * What has happened to a recording, derived on every read from the four stamps
 * and stored nowhere.
 *
 * There is no status column underneath this, for ADR-0024's reason and
 * ADR-0031's: `resolved_at` being null is the whole of *unresolved*, and
 * `closed_at` the whole of *closed*, precisely so that a second answer cannot
 * come to disagree with the first.
 *
 * Failed is read first. A retry clears the failure before the vendor is called
 * again, so a row carrying both a failure and a start is one that failed after
 * starting — which is every failure there is.
 */
function transcriptionState(capture: {
  transcribingSince: Date | null;
  transcribedAt: Date | null;
  failedAt: Date | null;
}): 'queued' | 'transcribing' | 'transcribed' | 'failed' {
  if (capture.failedAt !== null) {
    return 'failed';
  }
  if (capture.transcribedAt !== null) {
    return 'transcribed';
  }
  return capture.transcribingSince === null ? 'queued' : 'transcribing';
}

/**
 * A recording on the wire: what the vendor heard, what state it is in, and the
 * observation it became — never the key its audio is under.
 *
 * The observation itself and not its id, because *committed* is exactly "there
 * is one", and a screen holding both an id and a record could show a draft
 * beside the words it already became. The storage key is the object store's
 * business and means something different the day the adapter changes, which is
 * why a photograph does not carry one either.
 */
export function voiceCaptureOnTheWire(capture: StoredCapture) {
  const { storageKey: _key, observationId: _row, observation, ...onTheWire } = capture;
  return {
    ...onTheWire,
    state: transcriptionState(capture),
    observation: observation === null ? null : withLocation(observation),
  };
}

/** A walk's reports, in the order they were asked for (issue #13). */
export const reportsMade = {
  orderBy: [{ createdAt: 'asc' }],
} satisfies Prisma.SiteVisit$reportsArgs;

/**
 * What has happened to a report, derived on every read from the four stamps
 * and stored nowhere.
 *
 * `transcriptionState`'s shape directly above, and for the same reasons: a
 * status column would be a second answer that could disagree with the stamps,
 * which ADR-0024, ADR-0031 and ADR-0034 each refused for a different record.
 *
 * Failed is read first, as it is there — but for a different reason worth
 * saying, because the one above it does not apply. A recording clears its
 * failure on retry, so a row carrying both is one that failed after starting;
 * a report clears nothing, because a second attempt is a second row. A report
 * that failed carries its start for good, and *failed* is what it is.
 */
function renderingState(report: {
  renderingSince: Date | null;
  renderedAt: Date | null;
  failedAt: Date | null;
}): 'queued' | 'rendering' | 'rendered' | 'failed' {
  if (report.failedAt !== null) {
    return 'failed';
  }
  if (report.renderedAt !== null) {
    return 'rendered';
  }
  return report.renderingSince === null ? 'queued' : 'rendering';
}

/**
 * A report on the wire: what state it is in and how big the document is —
 * never the key its bytes are under.
 *
 * Here rather than in `routes/reports.ts` because two records return it: a
 * walk lists its reports, and the report routes return one. That is the same
 * reason `photoOnTheWire` and `voiceCaptureOnTheWire` are here (ADR-0033).
 */
export function reportOnTheWire(report: SiteVisitReport) {
  const { storageKey: _key, ...onTheWire } = report;
  return { ...onTheWire, state: renderingState(report) };
}
