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
 * A day with its month said out loud, which is how this document prints one
 * (issue #119).
 *
 * `dayIn` is the ISO face and stays the wire's: `visitedOn` is a field a screen
 * parses. This is the artifact that leaves the product, read by an owner and a
 * contractor who were not on the walk, and `2026-07-23` is a column. Written
 * here rather than in `zone.ts` because one record reads it, which is
 * ADR-0033's rule for where a thing lives; it moves into the leaf when a second
 * one reaches for it.
 *
 * `en-GB` for `23 July 2026` — day first and no comma, which is the form that
 * is unambiguous to a reader of either convention.
 */
function longDayIn(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(instant);
}

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
    /*
     * Not uppercased, and this is the second property found to reach the PDF's
     * text layer rather than only its glyphs (issue #119). The job printed as
     * 'MERCY GENERAL — 4TH FLOOR ICU RENOVATION' and came back out of the
     * finished document that way, so a reader searching the issued report for
     * the name as written found nothing — while the footer printed the same
     * name in its own case, leaving one document spelling the job two ways.
     * Exactly ADR-0035's letter-spacing finding, arriving through
     * 'text-transform': a screen's CSS habits do not carry to a document.
     *
     * The column headings below keep theirs. They are labels and not names —
     * nobody searches an issued report for the word "Arrived" — and at 8pt the
     * small caps are what separates a heading row from the rule under it.
     */
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
    /*
     * Kept with what it heads (issue #119). "Issues" printed alone at the foot
     * of page 1 with its rule drawn under it, a quarter of a page of white
     * below it and the first finding overleaf — which reads as a page that
     * failed to print. '.finding h3' has had this since issue #13; the section
     * heads above it did not.
     */
    break-after: avoid;
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
  .at { white-space: nowrap; font-variant-numeric: tabular-nums; }
  /*
   * The schedule is four narrow columns and is sized to them (issue #119,
   * plate R-01). At full width the unfiled count sat against the right margin,
   * about 12cm of white from the floor it counts, which is far enough that a
   * reader tracks it against the wrong row. The observation table below is the
   * opposite case and keeps the full measure: its Observed column is prose and
   * wants every millimetre.
   */
  .schedule { width: auto; }
  .schedule th, .schedule td { padding-right: 22pt; }
  /* The unfiled count on a floor's row: a number, read down the column. */
  .count { white-space: nowrap; text-align: right; font-variant-numeric: tabular-nums; }
  th.count { text-align: right; }
  .observations .at { width: 12%; }
  .observations .where { width: 28%; }
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
  /*
   * Never split from the location that labels it (issue #119). A finding
   * taller than a page has to break somewhere and 'break-inside: avoid-page'
   * on '.finding' cannot stop it; what it can do is break between sightings.
   * Without this the page ended with a bare '10:35 · Floor 1 — Corridor 1A,
   * Side A' and the words it labelled started the next one.
   */
  .sighting { margin: 5pt 0 0; padding-left: 10pt; border-left: 1.5pt solid #e4dfd9; break-inside: avoid; }
  .sighting p { margin: 0; }
  .sighting .at, .sighting .where { display: inline; width: auto; color: #5c5651; font-size: 9.5pt; }
  .evidence { margin-top: 7pt; display: flex; flex-wrap: wrap; gap: 6pt; align-items: flex-start; }
  /*
   * As wide as its photograph and no wider. A fixed column width drew the
   * border around the *box* rather than the picture, so a portrait sat in the
   * left two-thirds of an empty frame; sizing off the height instead means the
   * rule hugs the image whatever shape it is. 32% is a 4:3 landscape at the
   * height below, which is the widest thing a phone produces.
   */
  .evidence figure { margin: 0; max-width: 32%; break-inside: avoid; }
  /*
   * One box, and every figure in a row gets the same one (issue #119). The
   * bound used to be 'max-height' alone, so a figure was as tall as its own
   * photograph and the captions under a row of three sat at three different
   * heights — worst where a portrait stood between two landscapes, which is
   * what a walk produces. A fixed box puts the filenames on one line, which is
   * how a row of evidence is read: the name is the mechanism.
   *
   * 45mm rather than ADR-0035's 70mm, and inside it. 70mm was the bound that
   * stopped a portrait photograph off a phone being a page of its own; read as
   * issued output it is still nearly half the page for one picture, under a
   * finding whose subject is the words above it. Containing rather than
   * covering keeps the aspect ratio, so evidence is never stretched to fill
   * its box.
   */
  .evidence img {
    display: block;
    height: 45mm;
    width: auto;
    max-width: 100%;
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
  .observations .shown { width: 22%; }
  .shown .evidence { margin-top: 0; gap: 4pt; }
  .shown .evidence figure { max-width: 100%; }
  .shown .evidence img { height: 30mm; }
`;

/**
 * The running footer, which is Chrome's and not the stylesheet's.
 *
 * It has to be a `footerTemplate` (issue #119): Chrome implements no `@page`
 * margin boxes, so there is no CSS that puts a page number on every sheet.
 * What was here instead was a `<footer>` element, which flows — so it printed
 * once, at the end, and pages two and three carried neither the job nor a
 * number. A report is printed, separated, scanned and forwarded, and a page of
 * findings that says none of those things is a sheet nobody can file.
 *
 * Its own document, so its own font stack and its own inline styles; the 16mm
 * side padding is `@page`'s margin, which the template does not inherit.
 *
 * **Both halves arrive escaped**, unlike `figure` below, which escapes what it
 * is given. The two contracts differ because this one is handed a sentence
 * composed out of several values and that one is handed a row: escaping here
 * would have to happen before the composing anyway, and escaping twice would
 * print `&amp;` in a job name. Said out loud because one file holding two
 * helpers with opposite contracts is how an unescaped value eventually gets in.
 */
function runningFooter(about: string, rendering: string): string {
  return `<div style="width:100%;padding:0 16mm;font:7.5pt/1.4 'Iowan Old Style',Palatino,Georgia,'Times New Roman',serif;color:#5c5651;display:flex;justify-content:space-between;gap:8mm;">
  <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${about}</span>
  <span style="white-space:nowrap">${rendering} · page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
</div>`;
}

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
 *
 * Since issue #119 the union is what the page **prints** and no longer how it
 * **groups**: a photograph its sighting carries prints inside that sighting and
 * one stamped to the finding prints under the finding, because a reader given
 * the union as one row could not tell which look produced which picture. The
 * two halves are the same two this reads, so nothing is added or dropped and
 * the order within each stays `inTheOrderTaken`'s. What this list is still for
 * is the bytes: every photograph the page will show, fetched once.
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
 * A document and the footer that runs under every page of it.
 *
 * Two strings rather than one because the footer is not part of the page:
 * Chrome renders it into the `@page` margin from a template of its own, which
 * is the only way a page number reaches a sheet.
 */
export type Composed = { html: string; footer: string };

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
 *
 * `renderingSince` is the instant the worker stamped on the row before calling
 * this, and the footer prints it: a report is a record of a rendering
 * (ADR-0035), and the one fact that tells two renderings of the same walk
 * apart is when each was made. Taken as an argument and never read off a clock
 * here, so the page and the row cannot say different things (ADR-0022).
 */
export async function composeReport(
  prisma: PrismaClient,
  objectStore: ObjectStore,
  siteVisitId: string,
  renderingSince: Date,
): Promise<Composed> {
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
  const dayInWords = (instant: Date) => longDayIn(instant, project.timezone);
  const clock = (instant: Date) => clockIn(instant, project.timezone);

  // A walk that is still under way is a real state to render a report from:
  // ADR-0030 made `ended_at` nullable precisely so a visit exists before it is
  // over, and the schedule below says the same thing about a floor.
  const when =
    visit.endedAt === null
      ? `${dayInWords(visit.startedAt)} · from ${clock(visit.startedAt)}, still under way`
      : `${dayInWords(visit.startedAt)} · ${clock(visit.startedAt)}–${clock(visit.endedAt)}`;

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

  /**
   * A row of evidence, or nothing at all where there is none to show.
   *
   * The three places a page shows photographs — a non-issue's cell, a
   * sighting, a finding — and one shape, so a row cannot come to be spelled
   * differently depending on what it hangs under.
   */
  const shownUnder = (photos: { id: string; filename: string }[]) =>
    photos.length === 0
      ? ''
      : `
      <div class="evidence">${all(photos.map(figure))}
      </div>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<!--
  The ISO face here and nowhere else on the page. A title is what a viewer puts
  in its window and what a folder of these sorts by, which is the one reading
  of a date that wants the columns.
-->
<title>${escape(`${project.projectNumber} site visit report ${dayIn(visit.startedAt, project.timezone)}`)}</title>
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
      : /*
         * The designation bare, under a column that already says the word
         * (issue #119, plate R-01). ADR-0030's rule is that the column holds
         * `3` and the render supplies the word; here the table heading is the
         * render supplying it, and `Floor 4` under `FLOOR` says it twice. The
         * sightings below are the other case and still spell it in full, since
         * `Floor 3 — Corridor 3A, Side A` is a sentence with no heading over
         * it.
         */
        `<table class="schedule">
    <thead><tr><th class="at">Arrived</th><th class="at">Left</th><th>Floor</th><th class="count">Unfiled</th></tr></thead>
    <tbody>${all(
      visit.floors.map(
        (floor) => `
      <tr>
        <td class="at">${clock(floor.startedAt)}</td>
        <td class="at">${floor.completedAt === null ? NONE : clock(floor.completedAt)}</td>
        <td>${escape(floor.floor)}</td>
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
      : `<table class="observations">
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
        <td class="shown">${shownUnder(observation.photos)}</td>`
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
      <p>${escape(observation.observed)}</p>${shownUnder(observation.photos)}
    </div>`,
      ),
    )}${
      /*
       * What is stamped to the finding itself, under every sighting because it
       * belongs to none of them (issue #119). The other half of ADR-0056's
       * union prints above, inside the sighting that carries it: a photograph
       * bound to an observation evidences *that look*, and the page used to
       * print both halves as one row after the last sighting, where a reader
       * could not tell which look produced which picture.
       */
      shownUnder(finding.photos)
    }
  </article>`,
          ),
        )
  }
</section>
</body>
</html>`;

  return {
    html,
    footer: runningFooter(
      // What a loose sheet needs to be filed: the job it is about and the walk
      // it is of. Both are already on page one; a report is printed, separated
      // and scanned, and the sheet that carries a finding is the one most
      // likely to travel on its own.
      escape(
        `${project.projectNumber} · ${project.name} · site visit of ${dayInWords(visit.startedAt)}`,
      ),
      // No zone beside it, though plate R-01 draws one. The header states the
      // frame once and it governs every time in the document, this one
      // included (ADR-0054); on a footer that runs, naming it again would name
      // it once per page, which is the repetition that rule exists to stop.
      // The plate draws a single sheet and could not have said so.
      escape(`Rendered ${dayInWords(renderingSince)} ${clock(renderingSince)}`),
    ),
  };
}
