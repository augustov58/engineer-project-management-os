/**
 * The site visit report: what a walk becomes, as HTML (issue #13).
 *
 * The only artifact that leaves this product. It is issued to parties outside
 * the tool and carries the author's professional name, which is why ADR-0025
 * gives it a stylesheet of its own rather than the screen's — "reviewed as
 * issued output: read as a PDF of a real visit, not inspected as a page".
 *
 * It owns nothing it prints. The metadata, the schedule, the observations and
 * the findings are read here at the moment of rendering and copied into no
 * column, so a report cannot come to disagree with the record it is a
 * rendering of. `pdf.ts` turns what this returns into the document.
 */

import type { ObjectStore } from './object-store.js';
import { inTheOrderTaken, renderLocation } from './wire.js';
import { clockIn, dayIn } from './zone.js';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';

/**
 * How an issue's stable identifier prints, and the one format decision this
 * slice was left to make.
 *
 * ADR-0031 stored the bare integer and refused to invent `T-12-003` on read,
 * recording that "issue #13 still chooses how a report prints the number";
 * ADR-0032 restated the refusal. This is the choice, and it invents nothing:
 * the record's name and the identifier, which is the shape ADR-0030 already
 * gave a floor — `floor` holds `3` and the render supplies the word — and the
 * shape the filename grammar already carries in, `issue-7`.
 *
 * The number stays scoped to the project, and the project is named in the
 * header block above every one of these.
 */
export function issueIdentifier(number: number): string {
  return `Issue ${number}`;
}

/** The em dash the grammar and the schedule both use for a missing end. */
const NONE = '—';

/**
 * Text into HTML. Every value printed below goes through here.
 *
 * What was observed is free text the engineer spoke or typed, a qualifier is
 * free text, and a project's name is free text. Interpolated raw, an ampersand
 * in a room name would corrupt the markup and a stray `<` would swallow the
 * rest of the page — in a document issued outside the tool, which is the one
 * place a silently truncated table must not happen.
 */
function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The print stylesheet (ADR-0025).
 *
 * A4 with a 16mm margin, one serif family for the body because this is a
 * document and not a screen, and the rules that make it page correctly: a
 * table header repeats across a page break, a row is never split, and a
 * finding keeps its heading with at least the first of its sightings. Without
 * those three a report breaks wherever it lands, which is the difference
 * between an issued deliverable and a printed web page.
 */
const STYLESHEET = `
  @page { size: A4; margin: 16mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 10.5pt/1.5 "Iowan Old Style", Palatino, Georgia, "Times New Roman", serif;
    color: #14110f;
  }
  header { border-bottom: 1.5pt solid #14110f; padding-bottom: 8pt; margin-bottom: 18pt; }
  .job {
    margin: 0;
    font-size: 9pt;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: #5c5651;
  }
  h1 { margin: 2pt 0 0; font-size: 19pt; font-weight: 600; letter-spacing: -0.01em; }
  .when { margin: 4pt 0 0; font-size: 10.5pt; color: #5c5651; }
  h2 {
    margin: 20pt 0 7pt;
    font-size: 9.5pt;
    font-weight: 700;
    /*
     * Under a tenth of an em, and that is a constraint rather than a taste.
     * Above it Chrome emits every glyph of a heading as its own text run, so
     * "Notable Observations (Non-Issues)" comes back out of the finished PDF
     * as "N O TA B L E ..." — a heading nobody can search for or copy, in the
     * one artifact this product issues to people outside it. Measured at
     * 0.11em, where it breaks, and at 0.09em, where it does not.
     */
    letter-spacing: 0.09em;
    /*
     * Not uppercased, unlike the labels above and below. "Notable Observations
     * (Non-Issues)" is a name the vault writes exactly that way, and this is
     * the document that issues it — the weight and the spacing carry the
     * hierarchy without the page renaming the thing it is printing.
     */
    color: #3d3833;
    border-bottom: 0.5pt solid #cdc7c0;
    padding-bottom: 3pt;
  }
  section { break-inside: auto; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  th {
    text-align: left;
    font-size: 8pt;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: #5c5651;
    padding: 0 8pt 4pt 0;
  }
  td { padding: 4pt 8pt 4pt 0; border-top: 0.5pt solid #e4dfd9; vertical-align: top; }
  td:last-child, th:last-child { padding-right: 0; }
  .at { white-space: nowrap; width: 12%; font-variant-numeric: tabular-nums; }
  .where { width: 28%; }
  /* The unfiled count on a floor's row: a number, read down the column. */
  .count { white-space: nowrap; width: 10%; text-align: right; font-variant-numeric: tabular-nums; }
  th.count { text-align: right; }
  .nothing { color: #5c5651; font-style: italic; margin: 0; }
  /*
   * The photographs that landed on no floor at all, under the schedule rather
   * than in it: there is no row for a floor nobody walked, and a count nobody
   * can see is the silence ADR-0056 is against.
   */
  .adrift { margin: 6pt 0 0; font-size: 9.5pt; color: #5c5651; }
  .finding { break-inside: avoid-page; margin-top: 14pt; }
  .finding h3 {
    margin: 0 0 1pt;
    font-size: 12pt;
    font-weight: 600;
    break-after: avoid;
  }
  .category { font-size: 9.5pt; font-weight: 400; color: #5c5651; }
  .closed {
    font-size: 8pt;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: #5c5651;
    border: 0.5pt solid #cdc7c0;
    border-radius: 2pt;
    padding: 0 4pt;
    margin-left: 4pt;
  }
  .sighting { margin: 5pt 0 0; padding-left: 10pt; border-left: 1.5pt solid #e4dfd9; }
  .sighting p { margin: 0; }
  .sighting .at, .sighting .where { display: inline; width: auto; color: #5c5651; font-size: 9.5pt; }
  .evidence { margin-top: 7pt; display: flex; flex-wrap: wrap; gap: 6pt; }
  .evidence figure { margin: 0; width: 30%; break-inside: avoid; }
  /*
   * Bounded in both directions. Width alone leaves a portrait photograph off a
   * phone — which is most of them — as tall as it is narrow, and three of them
   * under one finding would be a page each. Containing rather than covering
   * keeps the aspect ratio, so evidence is never stretched to fill its box.
   */
  .evidence img {
    width: 100%;
    height: auto;
    max-height: 70mm;
    object-fit: contain;
    border: 0.5pt solid #cdc7c0;
  }
  .evidence figcaption { font-size: 7.5pt; color: #5c5651; word-break: break-all; margin-top: 2pt; }
  /*
   * An observation's evidence, in a table cell rather than across the width of
   * a finding (issue #113). One per line and half the height: a column beside
   * three others has a quarter of the page, and a figure sized for a finding
   * would push the row it is in onto a page of its own.
   */
  .shown { width: 22%; }
  .shown .evidence { margin-top: 0; gap: 4pt; }
  .shown .evidence figure { width: 100%; }
  .shown .evidence img { max-height: 35mm; }
  footer {
    margin-top: 22pt;
    padding-top: 6pt;
    border-top: 0.5pt solid #cdc7c0;
    font-size: 8.5pt;
    color: #5c5651;
  }
`;

/** The walk, everything it produced, and the job it was against. */
const visitInclude = {
  project: {
    select: { projectNumber: true, name: true, timezone: true },
  },
  // Whose name the page prints (issue #112, ADR-0055 part 5). Read through
  // the relation at the moment of rendering and copied into no column, so a
  // report cannot come to disagree with the record it is a rendering of —
  // the same trade this file already makes for the project's name and number.
  // Who asked for the rendering is an audit fact and is not printed.
  conductedBy: { select: { name: true } },
  floors: { orderBy: { startedAt: 'asc' } },
  observations: {
    orderBy: [{ observedAt: 'asc' }, { createdAt: 'asc' }],
    include: {
      // Whether this observation became a finding, and nothing more. The
      // non-issue table is every observation for which this list is empty —
      // ADR-0030 put no status on the row to read instead, deliberately, so
      // that staying an observation stayed the default path.
      issues: { select: { issueId: true } },
      // What evidences it (issue #113, ADR-0056). No `siteVisitId` narrowing
      // beside it, unlike a finding's: a photograph and the observation it
      // evidences are on the same walk, refused at the boundary, so there is
      // no cross-walk binding for a `where` here to exclude.
      photos: { orderBy: [{ takenAt: 'asc' }, { createdAt: 'asc' }] },
    },
  },
  /**
   * The walk's **unfiled** photographs: bound to neither an observation nor a
   * finding, whatever floor they landed on (issue #113, ADR-0056).
   *
   * Not the walk's photographs. The document prints evidence beside what it
   * evidences and reads every one of those through the thing it is under, so
   * the only photographs this list is for are the ones that print nowhere —
   * counted so the omission is visible rather than silent.
   */
  photos: {
    where: { observationId: null, issueId: null },
    select: { floor: true },
  },
  // `satisfies` rather than `as const`, for the reason `issueInclude` in
  // `wire.ts` records: Prisma's `orderBy` takes a mutable array, and `as
  // const` makes this one readonly.
} satisfies Prisma.SiteVisitInclude;

/**
 * The findings sighted on this walk, with the sightings that were made on it
 * and the photographs taken on it.
 *
 * Both narrowings are `siteVisitId`, and both are the point. The report is a
 * record of one afternoon: ADR-0031 left it to this slice to say which
 * sighting's location an issue prints and gave it "the whole list to choose
 * from", and ADR-0032 had already reasoned the same way about the evidence —
 * "July's photograph does not evidence August's re-observation, and the report
 * about to be written is August's". An issue seen twice on this walk prints
 * both, because both happened on it.
 *
 * The `some` clause is `GET /site-visits/:id/issues-without-photos`'s, which
 * is already how this product says "the findings seen on this walk".
 */
function findingsSightedOn(prisma: PrismaClient, siteVisitId: string) {
  return prisma.issue.findMany({
    where: { observations: { some: { observation: { siteVisitId } } } },
    orderBy: { number: 'asc' },
    include: {
      observations: {
        where: { observation: { siteVisitId } },
        orderBy: [
          { observation: { observedAt: 'asc' } },
          { observation: { createdAt: 'asc' } },
        ],
        select: {
          observation: {
            // The derived half of the evidence (issue #113, ADR-0056). The
            // sightings are already narrowed to this walk above, so their
            // photographs are this afternoon's without a `where` of their own.
            include: {
              photos: { orderBy: [{ takenAt: 'asc' }, { createdAt: 'asc' }] },
            },
          },
        },
      },
      photos: {
        where: { siteVisitId },
        orderBy: [{ takenAt: 'asc' }, { createdAt: 'asc' }],
      },
    },
  });
}

/** A photograph, as much of one as the page needs: a caption and its bytes. */
type Printed = {
  id: string;
  filename: string;
  contentType: string;
  storageKey: string;
  takenAt: Date;
  createdAt: Date;
};

/**
 * A finding's evidence on this walk, **derived** (issue #113, ADR-0056): what
 * is stamped to it, union what its sightings carry.
 *
 * The same union `withSightings` takes in `wire.ts`, and deliberately not
 * shared with it: that one is every walk's and reads a row that has been
 * through `photoOnTheWire`, and this one is one afternoon's and reads the row.
 * Two readers of one rule, each narrowed differently — the thing to keep in
 * step is the rule, which is ADR-0056's and is written down there.
 *
 * Nothing is deduplicated, and that rests on two constraints rather than one.
 * The CHECK makes the two lists disjoint — a photograph holds at most one of
 * `observation_id` and `issue_id` — and `issue_observations`' composite key
 * makes an observation appear under a finding once, so the sightings cannot
 * contribute the same photograph twice either.
 */
function evidenceFor(finding: {
  photos: Printed[];
  observations: { observation: { photos: Printed[] } }[];
}): Printed[] {
  return [
    ...finding.photos,
    ...finding.observations.flatMap(({ observation }) => observation.photos),
  ].sort(inTheOrderTaken);
}

/** The pieces of a repeated section, concatenated. */
function all(html: string[]): string {
  return html.join('');
}

/**
 * The walk, rendered.
 *
 * Reads the record and returns the document as HTML. The photographs are
 * embedded as data URIs rather than linked: the renderer loads this string and
 * nothing else, so a `<img src>` pointing at the API would be a second thing
 * that has to be reachable — from inside the process that is serving it — for
 * an issued report to contain its evidence.
 *
 * That bounds a report by the size of the walk's photographs, which the upload
 * route already caps at twelve mebibytes each. A walk with a hundred of them
 * would build a very large string here; the walks this is for have a handful
 * per finding, and the honest fix when that stops being true is to stream them
 * into the renderer rather than to link them.
 */
export async function composeReport(
  prisma: PrismaClient,
  objectStore: ObjectStore,
  siteVisitId: string,
): Promise<string> {
  const visit = await prisma.siteVisit.findUnique({
    where: { id: siteVisitId },
    include: visitInclude,
  });
  if (visit === null) {
    // The row pointed at a walk that is not there. Nothing deletes a site
    // visit, so this is unreachable rather than merely unlikely — and a
    // rendering that quietly produced an empty document would be worse than a
    // failure the screen can show.
    throw new Error('the site visit this report is of no longer exists');
  }

  const findings = await findingsSightedOn(prisma, siteVisitId);

  // The majority case, and the reason it comes first (story 56). An
  // observation is a non-issue exactly when nothing points at it.
  const nonIssues = visit.observations.filter(
    (observation) => observation.issues.length === 0,
  );

  /** Each finding's evidence, derived once and read twice below. */
  const derived = new Map(
    findings.map((finding) => [finding.id, evidenceFor(finding)] as const),
  );

  /**
   * The evidence, read one photograph at a time and inlined as it goes.
   *
   * Over one list rather than nested inside the findings, since issue #113:
   * an observation's photographs print too, and a finding's are reached
   * through its sightings, so a photograph can be arrived at more than one way
   * and the `Map` is what stops it being fetched and inlined twice.
   */
  const printed = [
    ...[...derived.values()].flat(),
    ...nonIssues.flatMap((observation) => observation.photos),
  ];
  const evidence = new Map<string, string>();
  for (const photo of printed) {
    if (evidence.has(photo.id)) {
      continue;
    }
    const bytes = await objectStore.get(photo.storageKey);
    evidence.set(
      photo.id,
      `data:${photo.contentType};base64,${bytes.toString('base64')}`,
    );
  }

  /**
   * How many unfiled photographs landed on each floor, and how many landed on
   * none (issue #113, ADR-0056).
   *
   * Keyed by the designation, because that is what both sides hold: ADR-0030
   * made `photos.floor` and `site_visit_floors.floor` the same type joined by
   * value, and this is the second use that join has had. A floor nobody
   * formally started has no schedule row, so its photographs are counted with
   * the floorless under the table rather than being silently dropped.
   */
  const unfiled = new Map<string, number>();
  let adrift = 0;
  for (const photo of visit.photos) {
    if (photo.floor === null) {
      adrift += 1;
      continue;
    }
    unfiled.set(photo.floor, (unfiled.get(photo.floor) ?? 0) + 1);
  }
  const scheduled = new Set(visit.floors.map((floor) => floor.floor));
  for (const [floor, count] of unfiled) {
    if (!scheduled.has(floor)) {
      adrift += count;
    }
  }

  const { project } = visit;
  /**
   * The day and the clock time of an instant are read **in the project's zone**,
   * as every other surface in this product reads them (ADR-0054).
   *
   * They are bound to that zone inside `render` rather than taken as arguments,
   * because a report is one document about one building: every time on the page
   * is in the same frame, and the header says which frame once. There is no
   * second reading for a reader in another zone — a walk happened where the
   * building is.
   *
   * ADR-0030 left the question open, ADR-0050 closed it as the UTC face, and
   * **ADR-0054 supersedes 0050** on the trigger 0050 itself named: the UTC face
   * was the engineer's typed wall clock for anything typed and was the
   * engineer's offset out for anything the injected TimeSource stamped, so the
   * printed page could only agree with the screen while both were wrong the same
   * way (issue #97).
   */
  const day = (instant: Date) => dayIn(instant, project.timezone);
  const clock = (instant: Date) => clockIn(instant, project.timezone);

  // A walk that is still under way is a real state to render a report from:
  // ADR-0030 made `ended_at` nullable precisely so a visit exists before it is
  // over, and the schedule below says the same thing about a floor.
  const when =
    visit.endedAt === null
      ? `${day(visit.startedAt)} · from ${clock(visit.startedAt)}, still under way`
      : `${day(visit.startedAt)} · ${clock(visit.startedAt)}–${clock(visit.endedAt)}`;

  // The zone, once and in the header (ADR-0054). Every time below it is in
  // this frame, so saying so beside each one would be saying it forty times;
  // the IANA name rather than an abbreviation, because `EST` is four different
  // zones and a report is read by people who were not on the walk.

  // Printed only when something is there to print, the way a finding's
  // evidence is. An "Evidence" heading over a column of blanks in a document
  // issued under the author's name reads as evidence that went missing, which
  // is the opposite of what the column is for — and the opposite answer to the
  // unfiled count below, which renders its zero precisely because the count is
  // the signal (ADR-0038).
  const anyEvidence = nonIssues.some(
    (observation) => observation.photos.length > 0,
  );

  /** One photograph, inlined, wherever a page shows one. */
  const figure = (photo: { id: string; filename: string }) => `
      <figure>
        <img src="${evidence.get(photo.id) ?? ''}" alt="${escape(photo.filename)}">
        <figcaption>${escape(photo.filename)}</figcaption>
      </figure>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escape(`${project.projectNumber} site visit report ${day(visit.startedAt)}`)}</title>
<style>${STYLESHEET}</style>
</head>
<body>
<header>
  <p class="job">${escape(project.projectNumber)} · ${escape(project.name)}</p>
  <h1>Site visit report</h1>
  <p class="when">${escape(when)} · ${escape(project.timezone)}</p>
  <p class="when">Conducted by ${escape(visit.conductedBy.name)}</p>
</header>

<section>
  <h2>Floors</h2>
  ${
    visit.floors.length === 0
      ? '<p class="nothing">No floors were recorded on the schedule.</p>'
      : `<table>
    <thead><tr><th class="at">Arrived</th><th class="at">Left</th><th>Floor</th><th class="count">Unfiled</th></tr></thead>
    <tbody>${all(
      visit.floors.map(
        (floor) => `
      <tr>
        <td class="at">${clock(floor.startedAt)}</td>
        <td class="at">${floor.completedAt === null ? NONE : clock(floor.completedAt)}</td>
        <td>Floor ${escape(floor.floor)}</td>
        <td class="count">${unfiled.get(floor.floor) ?? 0}</td>
      </tr>`,
      ),
    )}
    </tbody>
  </table>`
  }
  ${
    adrift === 0
      ? ''
      : `<p class="adrift">${adrift === 1 ? '1 photograph binned to no floor' : `${adrift} photographs binned to no floor`}, and prints nowhere.</p>`
  }
</section>

<section>
  <h2>Notable Observations (Non-Issues)</h2>
  ${
    nonIssues.length === 0
      ? '<p class="nothing">Every observation made on this visit became an issue.</p>'
      : `<table>
    <thead><tr><th class="at">Time</th><th class="where">Location</th><th>Observed</th>${anyEvidence ? '<th class="shown">Evidence</th>' : ''}</tr></thead>
    <tbody>${all(
      nonIssues.map(
        (observation) => `
      <tr>
        <td class="at">${clock(observation.observedAt)}</td>
        <td class="where">${escape(renderLocation(observation))}</td>
        <td>${escape(observation.observed)}</td>${
          anyEvidence
            ? `
        <td class="shown">${
          observation.photos.length === 0
            ? ''
            : `<div class="evidence">${all(observation.photos.map(figure))}
        </div>`
        }</td>`
            : ''
        }
      </tr>`,
      ),
    )}
    </tbody>
  </table>`
  }
</section>

<section>
  <h2>Issues</h2>
  ${
    findings.length === 0
      ? '<p class="nothing">No issues were raised on this visit.</p>'
      : all(
          findings.map(
            (finding) => `
  <article class="finding">
    <h3>${escape(issueIdentifier(finding.number))} <span class="category">${escape(finding.category)}</span>${
      finding.closedAt === null ? '' : '<span class="closed">Closed</span>'
    }</h3>
    ${all(
      finding.observations.map(
        ({ observation }) => `
    <div class="sighting">
      <p><span class="at">${clock(observation.observedAt)}</span> · <span class="where">${escape(renderLocation(observation))}</span></p>
      <p>${escape(observation.observed)}</p>
    </div>`,
      ),
    )}
    ${
      (derived.get(finding.id) ?? []).length === 0
        ? ''
        : `<div class="evidence">${all(
            (derived.get(finding.id) ?? []).map(figure),
          )}
    </div>`
    }
  </article>`,
          ),
        )
  }
</section>

<footer>
  ${escape(`${project.projectNumber} — ${project.name}`)}. Site visit of ${escape(day(visit.startedAt))}.
</footer>
</body>
</html>`;
}
