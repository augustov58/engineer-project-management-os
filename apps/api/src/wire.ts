/**
 * The read shapes more than one record's routes return.
 *
 * Derived on every read and stored nowhere — the rule ADR-0027, ADR-0028,
 * ADR-0030 and ADR-0031 each recorded for a different column. A shape used by
 * exactly one record stays with that record; these are here because two do,
 * and a leaf is what stops `site-visits` and `photos` importing each other.
 */

import { Prisma } from '../generated/prisma/client.js';

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
