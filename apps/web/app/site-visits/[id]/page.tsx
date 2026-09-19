import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  addPhoto,
  addRecording,
  bindPhotoEvidence,
  bindPhotoToFloor,
  bindPhotoToObservation,
  commitTurn,
  completeFloor,
  endSiteVisit,
  generateSiteVisitReport,
  raiseIssue,
  recordObservation,
  reobserveIssue,
  retryTranscription,
  setConductedBy,
  startFloor,
  typeATurn,
} from '../../actions';
import {
  getSiteVisit,
  listIssues,
  listIssuesWithoutPhotos,
  listUsers,
} from '../../api';
import { ConversationPanel } from '../../conversation-panel';
import { Disclosure } from '../../disclosure';
import { fieldSelectClassName } from '../../native-select';
import { RaiseIssueForm, ReobserveForm } from '../../issue-form';
import { SectionHead } from '../../section-head';
import { clock, day } from '../../wall-clock';
import {
  EvidenceShortlist,
  PhotoBindings,
  PhotoForm,
} from '../../photo-form';
import { ReportProgress, ReportState } from '../../report-form';
import { ObservationForm, StartFloorForm } from '../../site-visit-form';

export const dynamic = 'force-dynamic';

/**
 * The jumper's five sections, in the order density rule 5 names them (issue
 * #118, plate F-01).
 *
 * Anchors and no JavaScript, sticky under the header at 44 px. This is the
 * whole of the rule: at the baseline Photographs began 2 733 px down a 3 672 px
 * page — 3.4 screens of scrolling — and bar 3's *taps to reach* is what that
 * costs. One tap now.
 *
 * The brief's `### Field` paragraph lists Conversation before Observations and
 * rule 5's jumper lists it after; the plate draws the jumper. Two of the three
 * say Observations first, so that is the order.
 */
const SECTIONS = [
  { id: 'floors', label: 'Floors' },
  { id: 'observations', label: 'Observations' },
  { id: 'conversation', label: 'Conversation' },
  { id: 'photographs', label: 'Photographs' },
  { id: 'report', label: 'Report' },
];

export default async function SiteVisitRecord({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const visit = await getSiteVisit(id);
  if (visit === undefined) {
    notFound();
  }

  const projectId = visit.project.id;

  // Every time on this screen is the building's wall clock (ADR-0054). The
  // walk carries its job's zone rather than the screen fetching the project
  // for it: a stub that could label the row and not read its times would be
  // half a job.
  const zone = visit.project.timezone;

  // Everyone at the firm, so the walk can be moved to whoever actually made
  // it (issue #112). A visit is recorded as conducted by whoever typed it in,
  // which is right most of the time and wrong whenever a walk is written up
  // in the evening by somebody who was not on it.
  const users = await listUsers();

  const visitedOn = visit.visitedOn;

  // The job's register, so that an observation already on it says so instead
  // of offering to raise a second finding under a new identifier — and so that
  // a sighting on this walk can join one raised on an earlier one.
  const issues = await listIssues(projectId);
  const raisedFrom = new Map(
    issues.flatMap((issue) =>
      issue.observations.map((sighting) => [sighting.id, issue] as const),
    ),
  );

  // Read before the report is written, so it never ships with placeholders and
  // sits incomplete for four days (story 66).
  const unevidenced = await listIssuesWithoutPhotos(id);

  // Every floor this walk knows about: the ones formally started and the ones
  // only ever observed on. ADR-0030 joined those two by value rather than by a
  // foreign key precisely so a floor could exist without being scheduled, and
  // a correction has to be able to name one.
  const floors = [
    ...new Set([
      ...visit.floors.map((floor) => floor.floor),
      ...visit.observations.map((observation) => observation.floor),
    ]),
  ];

  /**
   * What evidences each observation, and what is still **unfiled** on each
   * floor (issue #113, ADR-0056).
   *
   * Both read off the payload already in hand rather than by a second fetch:
   * `GET /v1/site-visits/:id` carries every photograph on the walk, and an
   * observation's evidence is a photograph pointing at it. A route of their own
   * would be two more reads for facts that arrived with the first.
   *
   * Unfiled is the report's word and this screen's: on a floor and evidencing
   * nothing, which is exactly what prints nowhere. Keyed by the floor value,
   * the join ADR-0030 made by value and the first use it has had beyond the
   * document.
   */
  const evidencing = new Map<string, typeof visit.photos>();
  const unfiled = new Map<string, typeof visit.photos>();
  // On no floor at all, and evidencing nothing: the line the report prints
  // under its schedule table, because ADR-0056 has no row for these and a
  // count nobody can see is the silence it is against.
  let unplaced = 0;
  for (const photo of visit.photos) {
    if (photo.observationId !== null) {
      evidencing.set(photo.observationId, [
        ...(evidencing.get(photo.observationId) ?? []),
        photo,
      ]);
    } else if (photo.issueNumber === null && photo.floor !== null) {
      unfiled.set(photo.floor, [...(unfiled.get(photo.floor) ?? []), photo]);
    } else if (photo.issueNumber === null) {
      unplaced += 1;
    }
  }

  /** Every photograph on this walk that evidences nothing, floor or no floor. */
  const unfiledOnTheWalk =
    visit.photos.filter(
      (photo) => photo.observationId === null && photo.issueNumber === null,
    ).length;

  async function end() {
    'use server';
    await endSiteVisit(id, projectId);
  }

  async function generate() {
    'use server';
    await generateSiteVisitReport(id, projectId);
  }

  return (
    /*
      The **record measure**, `--measure-record: 44rem` (704 px), declared inert
      by issue #117 and consumed here for the first time (the brief's `## The
      spacing scale, and the measure`). The walk is a record being read: a line
      of prose at 16 px sits at 60–75 characters at this width, where the desk's
      1024 px put it at half as many again.
    */
    <div className="mx-auto grid max-w-[var(--measure-record)] gap-6">
      <div className="grid gap-1">
        <Link
          href={`/projects/${projectId}`}
          className="text-muted-foreground hover:text-foreground font-mono text-xs tracking-[0.06em] uppercase transition-colors"
        >
          &larr; {visit.project.projectNumber} &middot; {visit.project.name}
        </Link>

        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Site visit</h1>
          {visit.endedAt === null && <Badge variant="secondary">Under way</Badge>}
        </div>

        <p className="text-muted-foreground text-xs">
          <span className="tabular-nums">
            {visitedOn} &middot; {clock(visit.startedAt, zone)}
            {visit.endedAt === null ? '' : `–${clock(visit.endedAt, zone)}`}
          </span>{' '}
          &middot; {zone}
        </p>

        {/*
          Who walked the building, which is the name the **report** prints
          (issue #112, ADR-0055 part 5). Who typed the row and who asked for a
          rendering are audit facts and are not here.

          Native, for the reason every other select in this app is (ADR-0025):
          the action reads this out of `FormData`. At the field target since
          issue #118 — this screen is used one-handed.
        */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <form
            action={setConductedBy.bind(null, visit.id, projectId)}
            className="flex min-w-0 flex-wrap items-center gap-2"
          >
            <label
              htmlFor="conductedById"
              className="text-muted-foreground text-xs"
            >
              Conducted by
            </label>
            <select
              id="conductedById"
              name="conductedById"
              defaultValue={visit.conductedBy.id}
              className={fieldSelectClassName}
            >
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </select>
            <Button type="submit" variant="ghost" className="h-11 px-3">
              Change
            </Button>
          </form>

          {visit.endedAt === null && (
            <form action={end} className="sm:ml-auto">
              <Button type="submit" variant="ghost" className="h-11 px-3">
                End the visit
              </Button>
            </form>
          )}
        </div>
      </div>

      {/*
        Density rule 5, and the whole of bar 3's *taps to reach*. Sticky under
        the header at 44 px; `overflow-x-auto` because five anchors do not fit
        across a 390 px phone and wrapping them would make the bar two rows
        tall. Plain anchors: nothing here needs JavaScript, and a jumper that
        did would not work before hydration.
      */}
      <nav
        aria-label="Sections"
        className="bg-background sticky top-0 z-10 flex min-h-11 items-center gap-4 overflow-x-auto border-b text-xs"
      >
        {SECTIONS.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className="text-muted-foreground hover:text-foreground flex min-h-11 items-center whitespace-nowrap transition-colors"
          >
            {section.label}
          </a>
        ))}
      </nav>

      {/*
        The per-floor schedule. Its job is to be the window every photograph
        taken between the two stamps is attributed to (issue #11), which is why
        it reads as times rather than as a list of places — and, since ADR-0056,
        why each row carries its count of **unfiled** photographs and renders a
        zero, exactly as the report's own schedule table does.
      */}
      <section id="floors" className="grid scroll-mt-14 gap-3">
        <SectionHead
          aside={
            <span className="tabular-nums">
              {visit.floors.length === 0
                ? 'none started'
                : `${visit.floors.length} walked`}
            </span>
          }
        >
          Floors
        </SectionHead>

        {visit.floors.length > 0 && (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-muted-foreground text-xs font-semibold tracking-[0.06em] uppercase">
                <th className="pr-3 pb-1.5 text-left">Floor</th>
                <th className="pr-3 pb-1.5 text-left">Arrived</th>
                <th className="pr-3 pb-1.5 text-left">Left</th>
                <th className="pb-1.5 text-right">Unfiled</th>
              </tr>
            </thead>
            <tbody>
              {visit.floors.map((floor) => (
                <tr key={floor.id} className="border-t align-top">
                  <td className="py-3 pr-3 font-mono">{floor.floor}</td>
                  <td className="py-3 pr-3 tabular-nums">
                    {clock(floor.startedAt, zone)}
                  </td>
                  <td className="py-3 pr-3 tabular-nums">
                    {floor.completedAt === null ? (
                      <form
                        action={completeFloor.bind(
                          null,
                          floor.id,
                          id,
                          visitedOn,
                          projectId,
                        )}
                        className="flex flex-wrap items-center gap-2"
                      >
                        {/* Blank is now; filled in is a walk entered afterwards. */}
                        <Input
                          name="completedAt"
                          type="time"
                          aria-label={`Time floor ${floor.floor} was completed`}
                          className="h-11 w-28"
                        />
                        <Button
                          type="submit"
                          variant="ghost"
                          className="h-11 px-3"
                        >
                          Complete
                        </Button>
                      </form>
                    ) : (
                      clock(floor.completedAt, zone)
                    )}
                  </td>
                  <td className="py-3 text-right tabular-nums">
                    {unfiled.get(floor.floor)?.length ?? 0}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {unplaced > 0 && (
          <p className="text-muted-foreground text-xs">
            {unplaced === 1
              ? '1 photograph is on no floor at all.'
              : `${unplaced} photographs are on no floor at all.`}
          </p>
        )}

        <Disclosure summary="Start a floor">
          <StartFloorForm
            submit={startFloor.bind(null, id, visitedOn, projectId)}
          />
        </Disclosure>
      </section>

      {/*
        The non-issues table is the majority case, so this is the plain list it
        is. Becoming an issue is offered under each entry and never as part of
        recording one: the exception is a second act, and staying an
        observation is what happens if nothing more is done.

        An observation is **not its own screen and does not become one** (plate
        F-02): it is a block on the walk and a row in the report, read at the
        Record step with its location and time as meta and its evidence visible
        without opening anything.
      */}
      <section id="observations" className="grid scroll-mt-14 gap-3">
        <SectionHead
          aside={
            <span className="tabular-nums">
              {visit.observations.length} recorded
            </span>
          }
        >
          Observations
        </SectionHead>

        {visit.observations.length === 0 ? (
          <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-center text-xs">
            Nothing observed yet.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {visit.observations.map((observation) => {
              const finding = raisedFrom.get(observation.id);
              const evidence = evidencing.get(observation.id) ?? [];
              const loose = unfiled.get(observation.floor) ?? [];

              return (
                <li
                  key={observation.id}
                  className="grid min-h-11 gap-1.5 px-4 py-3"
                >
                  {/*
                    The composed grammar, exactly as the field says it. Rendered
                    by the API from the components, so this screen cannot spell
                    it a second way.
                  */}
                  <p className="text-muted-foreground text-xs">
                    <span className="tabular-nums">
                      {clock(observation.observedAt, zone)}
                    </span>{' '}
                    &middot; {observation.location}
                  </p>
                  <p className="text-base whitespace-pre-wrap">
                    {observation.observed}
                  </p>

                  {/*
                    What evidences it (issue #113, ADR-0056), beside what it
                    evidences — the arrangement the report prints. Through the
                    Next server, never straight at the API. The filenames under
                    the thumbnails because the name is the mechanism: a
                    photograph bound by `issue-12` is the one fact a thumbnail
                    cannot show.
                  */}
                  {evidence.length > 0 && (
                    <>
                      <ul className="flex flex-wrap gap-1.5">
                        {evidence.map((photo) => (
                          <li key={photo.id}>
                            <img
                              src={`/photos/${photo.id}/bytes`}
                              alt={photo.filename}
                              className="bg-muted size-14 rounded-md border object-cover"
                            />
                          </li>
                        ))}
                      </ul>
                      <p className="text-muted-foreground font-mono text-xs break-all">
                        {evidence.map((photo) => photo.filename).join(' · ')}
                      </p>
                    </>
                  )}

                  {/*
                    The unfiled photographs on this observation's floor, if
                    there are any. Offered here and not always, because an
                    empty picker is a control that can do nothing.
                  */}
                  {loose.length > 0 && (
                    <EvidenceShortlist
                      photos={loose}
                      timeZone={zone}
                      bind={bindPhotoToObservation.bind(
                        null,
                        observation.id,
                        id,
                        projectId,
                      )}
                    />
                  )}

                  {/*
                    Promoting is the deliberate exception, so it is a
                    disclosure under an observation rather than a step in
                    recording one — the non-issues table is the majority case
                    and stays the default path. Behind the disclosure since
                    issue #118: raising a finding and joining a sighting to one
                    both **create a record**, which is density rule 1, and the
                    plate draws an observation block as its words and its
                    evidence with no control standing open under them.
                  */}
                  {finding === undefined ? (
                    <Disclosure summary="Record as an issue">
                      <div className="flex flex-wrap items-start gap-2">
                        <RaiseIssueForm
                          submit={raiseIssue.bind(
                            null,
                            observation.id,
                            id,
                            projectId,
                          )}
                        />
                        {issues.length > 0 && (
                          <ReobserveForm
                            submit={reobserveIssue.bind(
                              null,
                              observation.id,
                              id,
                              projectId,
                            )}
                            issues={issues}
                          />
                        )}
                      </div>
                    </Disclosure>
                  ) : (
                    <Link
                      href={`/projects/${projectId}/issues/${finding.number}`}
                      className="inline-flex flex-wrap items-center gap-2 justify-self-start"
                    >
                      {/*
                        The state, not just the fact: a finding closed since
                        this walk must not read here as though it were still
                        open, which is what the other two screens say too.
                      */}
                      <Badge
                        variant={
                          finding.closedAt === null ? 'destructive' : 'secondary'
                        }
                      >
                        Issue {finding.number}
                      </Badge>
                      <span className="text-muted-foreground hover:text-foreground text-xs transition-colors">
                        {finding.category}
                        {finding.closedAt === null
                          ? ''
                          : ` · closed ${day(finding.closedAt, zone)}`}
                      </span>
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/*
          Density rule 1: the record screen shows the record, and the form that
          adds to it is a disclosure. This was the card headed "Or type an
          observation", which sat open under the conversation — where it read as
          an alternative to capture rather than as the other way of writing one
          down. Under Observations, where it belongs.
        */}
        <Disclosure summary="Add an observation">
          <ObservationForm
            submit={recordObservation.bind(null, id, visitedOn, projectId)}
          />
        </Disclosure>
      </section>

      {/*
        The walk's **conversation** (issue #114, ADR-0058): what the engineer
        captured, spoken or typed, and what the agent proposed back. One
        component since issue #118 — the brief's `## The conversation panel`,
        which ADR-0059 point 2 put there rather than in either ADR's ticket. A
        capture is a **draft** until the engineer has read it and confirmed it,
        so nothing here has written an observation and the list above stays what
        was actually recorded.
      */}
      <ConversationPanel
        id="conversation"
        siteVisitId={id}
        turns={visit.conversation.turns}
        runs={visit.conversation.runs}
        issues={issues}
        timeZone={zone}
        evidencing={evidencing}
        unfiled={unfiled}
        add={addRecording.bind(null, id, projectId)}
        typed={typeATurn.bind(null, id, projectId)}
        commit={(turnId) =>
          commitTurn.bind(null, turnId, id, visitedOn, projectId)
        }
        retry={(turnId) => retryTranscription.bind(null, turnId, id, projectId)}
        bindEvidence={(observationId) =>
          bindPhotoToObservation.bind(null, observationId, id, projectId)
        }
      />

      <section id="photographs" className="grid scroll-mt-14 gap-3">
        <SectionHead
          aside={
            <span className="tabular-nums">
              {visit.photos.length === 0
                ? 'none yet'
                : `${visit.photos.length} on this walk`}
            </span>
          }
        >
          Photographs
        </SectionHead>

        <p className="text-muted-foreground text-xs">
          Bin each to what it evidences &mdash; the floor alone leaves it
          unfiled.
        </p>

        {unevidenced.length > 0 && (
          <div className="border-destructive/40 bg-destructive/5 grid gap-2 rounded-lg border p-4">
            <p className="text-sm font-medium">
              {unevidenced.length === 1
                ? 'One finding on this walk has no photograph yet.'
                : `${unevidenced.length} findings on this walk have no photograph yet.`}
            </p>
            <ul className="flex flex-wrap gap-2">
              {unevidenced.map((finding) => (
                <li key={finding.id}>
                  <Link
                    href={`/projects/${projectId}/issues/${finding.number}`}
                    className="inline-flex items-center gap-2"
                  >
                    <Badge variant="outline">Issue {finding.number}</Badge>
                    <span className="text-muted-foreground hover:text-foreground text-xs transition-colors">
                      {finding.category}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {visit.photos.length > 0 && (
          <>
            <ul className="divide-y rounded-lg border">
              {visit.photos.map((photo) => (
                <li
                  key={photo.id}
                  className="flex min-h-11 items-center gap-3 px-4 py-3"
                >
                  {/*
                    Through the Next server, never straight at the API. The bin
                    cannot be seen to be wrong without seeing the photograph, so
                    this is what makes a two-second correction possible at all.
                  */}
                  <img
                    src={`/photos/${photo.id}/bytes`}
                    alt={photo.filename}
                    className="bg-muted size-14 shrink-0 rounded-md border object-cover"
                  />
                  <div className="grid min-w-0 flex-1 gap-1.5">
                    <p className="text-muted-foreground text-xs">
                      <span className="font-mono break-all">
                        {photo.filename}
                      </span>{' '}
                      &middot;{' '}
                      <span className="tabular-nums">
                        {clock(photo.takenAt, zone)}
                      </span>
                      {/*
                        Unfiled is about what it evidences and not about the
                        floor (issue #113, ADR-0056): a photograph on a floor
                        and nothing else prints nowhere, so the floor is no
                        longer half of what makes this worth saying. The floor's
                        own answer is the select beside it.
                      */}
                      {photo.observationId === null && photo.issueNumber === null
                        ? ' · unfiled'
                        : ''}
                    </p>
                    <PhotoBindings
                      floor={photo.floor}
                      floors={floors}
                      observationId={photo.observationId}
                      observations={visit.observations}
                      issueNumber={photo.issueNumber}
                      issues={issues}
                      timeZone={zone}
                      bindFloor={bindPhotoToFloor.bind(
                        null,
                        photo.id,
                        id,
                        projectId,
                      )}
                      bindEvidence={bindPhotoEvidence.bind(
                        null,
                        photo.id,
                        id,
                        projectId,
                      )}
                    />
                  </div>
                </li>
              ))}
            </ul>

            {/*
              Unfiled is a **count** and not a column of blanks (plate F-04),
              rendered at zero for ADR-0038's reason: a figure that vanished
              when it reached nought would read as one that had not loaded.
            */}
            <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
              <Badge
                variant={unfiledOnTheWalk === 0 ? 'secondary' : 'destructive'}
              >
                {unfiledOnTheWalk} unfiled
              </Badge>
              A floor-only photograph prints nowhere.
              {unplaced > 0 &&
                (unplaced === 1
                  ? ' 1 is on no floor at all.'
                  : ` ${unplaced} are on no floor at all.`)}
            </p>
          </>
        )}

        <Disclosure summary="Add the walk’s photographs">
          <PhotoForm add={addPhoto.bind(null, id, projectId)} timeZone={zone} />
        </Disclosure>
      </section>

      {/*
        The write-up, last on the page because it is the last thing that
        happens on a walk — and after the photographs, because the warning
        above is what story 66 asks be read *before* a report is generated.

        Generating again is another report and never an edit: a finding that
        had no photograph gets one, and this button is pressed a second time.
      */}
      <section id="report" className="grid scroll-mt-14 gap-3">
        <SectionHead
          aside={<ReportProgress siteVisitId={id} initial={visit.reports} />}
        >
          Report
        </SectionHead>

        {visit.reports.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {visit.reports.map((report) => (
              <li
                key={report.id}
                className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3"
              >
                <ReportState report={report} />
                <span className="text-muted-foreground text-xs tabular-nums">
                  {clock(report.createdAt, zone)}
                </span>
                {report.state === 'rendered' && (
                  <a
                    href={`/site-visit-reports/${report.id}/pdf`}
                    target="_blank"
                    rel="noopener"
                    className="ml-auto text-sm font-medium underline underline-offset-4"
                  >
                    Open the PDF
                  </a>
                )}
                {report.failure !== null && (
                  <span className="text-destructive text-xs">
                    {report.failure}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        <form action={generate}>
          <Button type="submit" variant="secondary" className="h-11 px-4">
            {visit.reports.length === 0
              ? 'Generate the report'
              : 'Generate it again'}
          </Button>
        </form>
      </section>

      <p className="text-muted-foreground text-xs">
        Visit recorded {day(visit.createdAt, zone)}.
      </p>
    </div>
  );
}
