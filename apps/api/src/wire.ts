/**
 * The read shapes more than one record's routes return.
 *
 * Derived on every read and stored nowhere — the rule ADR-0027, ADR-0028,
 * ADR-0030 and ADR-0031 each recorded for a different column. A shape used by
 * exactly one record stays with that record; these are here because two do,
 * and a leaf is what stops `site-visits` and `photos` importing each other.
 */

import { Prisma, type SiteVisitReport } from '../generated/prisma/client.js';
import { dayIn } from './zone.js';

/**
 * A project as it goes out: the whole row **minus** `issuesAllocated`, and
 * with `ingestToken` swapped for the address composed from it.
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
export function projectOnTheWire<
  T extends { issuesAllocated: number; ingestToken: string },
>(project: T, ingestDomain: string | null) {
  const { issuesAllocated: _sequence, ingestToken, ...onTheWire } = project;
  return {
    ...onTheWire,
    // The token is the only credential on a path that bypasses the interface
    // entirely, so it goes out composed or not at all (issue #19, ADR-0042).
    //
    // Null where no domain is configured, which is the honest answer: a
    // plausible-looking address on a deployment that receives no mail is one
    // the engineer would forward to, and the mail would go nowhere. It reads
    // as the omission it is, the way stripping `issuesAllocated` does.
    ingestAddress:
      ingestDomain === null ? null : `${ingestToken}@${ingestDomain}`,
  };
}

/**
 * A site visit on the wire, with the date it was.
 *
 * "One *dated* observation event" is the day the walk started, derived on
 * every read and stored nowhere — the shape ADR-0027 and ADR-0028 gave
 * *currently provisional* and *superseded*. A `visited_on` column would be a
 * second place for the same fact to be wrong, and the one place a visit could
 * come to be dated a different day from the one it started on.
 *
 * Derived **in the project's zone** since ADR-0054: a walk that ran into the
 * evening is a visit made that afternoon, and the UTC face of its start is
 * already tomorrow. The zone is passed in rather than read here, because a
 * sighting carries its walk without carrying the job.
 */
export function withDate<T extends { startedAt: Date }>(
  visit: T,
  timeZone: string,
) {
  return { ...visit, visitedOn: dayIn(visit.startedAt, timeZone) };
}

/**
 * The person a record names, as an `include` asks for them (issue #112).
 *
 * One shape for all three — a walk's **conducted by**, an open item's
 * **owner**, the **user** a ball came to — so that what a person looks like on
 * the wire is decided once. `include: { owner: true }` would hand back the
 * password hash, which is exactly what `userOnTheWire` below exists to stop
 * each route having to remember.
 */
export const namedUser = {
  select: { id: true, name: true, email: true },
} as const;

/**
 * A site visit on the wire, with the date it was and the person who made it
 * (issue #112, ADR-0055 part 5).
 *
 * The raw `conducted_by` id is swapped for the person, the way
 * `projectOnTheWire` swaps the ingest token for the address: what a screen and
 * the **report** want is a name, and a bare foreign key on the wire is one a
 * reader has to go and resolve. `userOnTheWire` is what keeps the hash off it.
 *
 * Separate from `withDate` rather than folded into it, because a **sighting**
 * carries its walk as a stub of three fields and has no person on it — an
 * issue's read names the walks it was seen on, not who made each of them.
 */
export function visitOnTheWire<
  T extends {
    startedAt: Date;
    conductedById: string;
    conductedBy: { id: string; name: string; email: string };
  },
>(visit: T, timeZone: string) {
  const { conductedById: _id, conductedBy: walker, ...rest } = visit;
  return { ...withDate(rest, timeZone), conductedBy: userOnTheWire(walker) };
}

/**
 * An open item on the wire, with the person it sits with (issue #112,
 * ADR-0055 part 5).
 *
 * The same swap `visitOnTheWire` makes, and needed in more places: an open
 * item is read back on its own, on the pending items view, and inside four
 * other records — a submission, an issue, a register entry and an assumption
 * record each name the items they are being chased for. Every one of those
 * goes through here, so a bare `owner_id` reaches no screen.
 */
export function openItemOnTheWire<
  T extends {
    ownerId: string;
    owner: { id: string; name: string; email: string };
  },
>(item: T) {
  const { ownerId: _id, owner: sitsWith, ...rest } = item;
  return { ...rest, owner: userOnTheWire(sitsWith) };
}

/** The open items a record is being chased for, read with their people. */
export const chasedItems = {
  orderBy: { openItem: { waitingSince: 'asc' } },
  select: { openItem: { include: { owner: namedUser } } },
} as const;

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

/**
 * The order `photosTaken` asks the database for, in JavaScript.
 *
 * It exists because a **union** of two ordered lists is not one, and since
 * issue #113 a finding's evidence is exactly that: what is stamped to it,
 * union its sightings'. Evidence out of order under a finding reads as a
 * second afternoon.
 *
 * One comparator with two readers — here and `report.ts`'s `evidenceFor` — so
 * the API's answer and the issued document cannot come to order the same
 * photographs differently. The two *unions* stay separate, being narrowed
 * differently (ADR-0056); this is the rule they share.
 */
export function inTheOrderTaken(
  one: { takenAt: Date; createdAt: Date },
  other: { takenAt: Date; createdAt: Date },
): number {
  return (
    one.takenAt.getTime() - other.takenAt.getTime() ||
    one.createdAt.getTime() - other.createdAt.getTime()
  );
}

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
          // The other half of this finding's evidence (issue #113, ADR-0056).
          // Read here rather than by a second query because the sightings are
          // already being loaded and a finding's evidence *is* them plus what
          // is stamped to it — one read, and the union is taken below.
          photos: photosTaken,
        },
      },
    },
  },
  openItems: chasedItems,
  // The photographs stamped directly to this finding (issue #11) — half of
  // its evidence, the other half being the sightings' above.
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
export function withSightings(found: Finding, timeZone: string) {
  const { observations, openItems, photos, ...issue } = found;

  /**
   * A finding's evidence, **derived** (issue #113, ADR-0056): the photographs
   * stamped to it, union the photographs of its sightings. Promotion writes
   * nothing to a photograph, so this is where the two halves meet — the one
   * place ADR-0032's *stamped, never derived* is amended, and for this path
   * only. The floor binding and the filename's are still stamped.
   *
   * Nothing is deduplicated because nothing can repeat: a photograph holds at
   * most one of `observation_id` and `issue_id` (the CHECK), so the two lists
   * are disjoint by construction, and `observation_id` is unique on a sighting
   * so an observation appears under a finding once.
   *
   * Sorted rather than concatenated: each half arrives ordered and the union of
   * two ordered lists is not one. `inTheOrderTaken` above is that sort, shared
   * with the report so the two cannot come to disagree.
   */
  const evidence = [
    ...photos,
    ...observations.flatMap(({ observation }) => observation.photos),
  ].sort(inTheOrderTaken);

  return {
    ...issue,
    observations: observations.map(({ observation }) => {
      // The sighting's own photographs come off here: they are read above as
      // the finding's evidence, and which sighting each one belongs to is not
      // a question this record answers (issue #96's second consequence, left
      // open by ADR-0056 on purpose).
      const { siteVisit, photos: _evidence, ...sighting } = observation;
      return {
        ...withLocation(sighting),
        siteVisit: withDate(siteVisit, timeZone),
      };
    }),
    openItems: openItems.map((row) => openItemOnTheWire(row.openItem)),
    photos: evidence.map(photoOnTheWire),
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

/**
 * A person, as every record that names one returns them (issue #105).
 *
 * A leaf shape because two records return it already — the session read and
 * the user list — and because it is the projection that keeps `password_hash`
 * off the wire by construction rather than by each route remembering to leave
 * it out. `disabled_at` is not here either: nothing renders it yet, and a
 * field on the wire that no screen reads is a field somebody will read.
 */
export function userOnTheWire(user: {
  id: string;
  name: string;
  email: string;
}): { id: string; name: string; email: string } {
  return { id: user.id, name: user.name, email: user.email };
}
