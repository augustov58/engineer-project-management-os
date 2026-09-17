import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
  isWorking,
  listIssues,
  listIssuesWithoutPhotos,
  listUsers,
} from '../../api';
import { selectClassName } from '../../native-select';
import { RaiseIssueForm, ReobserveForm } from '../../issue-form';
import { clock, day } from '../../wall-clock';
import {
  EvidenceShortlist,
  PhotoBindings,
  PhotoForm,
} from '../../photo-form';
import { ReportProgress, ReportState } from '../../report-form';
import { ObservationForm, StartFloorForm } from '../../site-visit-form';
import {
  CaptureState,
  ConversationProgress,
  DraftObservationForm,
  TypeATurn,
  VoiceRecorder,
} from '../../conversation';

export const dynamic = 'force-dynamic';

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
  for (const photo of visit.photos) {
    if (photo.observationId !== null) {
      evidencing.set(photo.observationId, [
        ...(evidencing.get(photo.observationId) ?? []),
        photo,
      ]);
    } else if (photo.issueNumber === null && photo.floor !== null) {
      unfiled.set(photo.floor, [...(unfiled.get(photo.floor) ?? []), photo]);
    }
  }

  async function end() {
    'use server';
    await endSiteVisit(id, projectId);
  }

  async function generate() {
    'use server';
    await generateSiteVisitReport(id, projectId);
  }

  return (
    <div className="space-y-8">
      <div>
        <Link
          href={`/projects/${projectId}`}
          className="text-muted-foreground hover:text-foreground text-sm transition-colors"
        >
          &larr; {visit.project.projectNumber} {visit.project.name}
        </Link>

        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            Site visit {visit.visitedOn}
          </h1>
          {visit.endedAt === null && <Badge variant="secondary">Under way</Badge>}
        </div>

        <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-4 text-sm">
          <span>
            {clock(visit.startedAt, zone)}
            {visit.endedAt === null ? '' : ` – ${clock(visit.endedAt, zone)}`}
          </span>
          {visit.endedAt === null && (
            <form action={end}>
              <Button type="submit" variant="ghost" size="sm">
                End the visit
              </Button>
            </form>
          )}
        </div>

        {/*
          Who walked the building, which is the name the **report** prints
          (issue #112, ADR-0055 part 5). Who typed the row and who asked for a
          rendering are audit facts and are not here.

          Native, for the reason every other select in this app is (ADR-0025):
          the action reads this out of `FormData`.
        */}
        <form
          action={setConductedBy.bind(null, visit.id, projectId)}
          className="text-muted-foreground mt-2 flex flex-wrap items-center gap-2 text-sm"
        >
          <label htmlFor="conductedById">Conducted by</label>
          <select
            id="conductedById"
            name="conductedById"
            defaultValue={visit.conductedBy.id}
            className={selectClassName}
          >
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name}
              </option>
            ))}
          </select>
          <Button type="submit" variant="ghost" size="sm">
            Change
          </Button>
        </form>
      </div>

      {/*
        The per-floor schedule. Its job is to be the window every photograph
        taken between the two stamps is attributed to (issue #11), which is why
        it reads as times rather than as a list of places.
      */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Floors</h2>
          <span className="text-muted-foreground text-sm">
            {visit.floors.length === 0
              ? 'none started'
              : `${visit.floors.length} walked`}
          </span>
        </div>

        {visit.floors.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {visit.floors.map((floor) => (
              <li
                key={floor.id}
                className="flex flex-wrap items-center gap-3 px-4 py-3"
              >
                <Badge variant="outline" className="font-mono">
                  Floor {floor.floor}
                </Badge>
                <span className="text-muted-foreground text-sm tabular-nums">
                  {clock(floor.startedAt, zone)}
                  {floor.completedAt === null
                    ? ''
                    : ` – ${clock(floor.completedAt, zone)}`}
                </span>
                {floor.completedAt === null && (
                  <form
                    action={completeFloor.bind(
                      null,
                      floor.id,
                      id,
                      visitedOn,
                      projectId,
                    )}
                    className="ml-auto flex items-center gap-2"
                  >
                    {/* Blank is now; filled in is a walk entered afterwards. */}
                    <Input
                      name="completedAt"
                      type="time"
                      aria-label={`Time floor ${floor.floor} was completed`}
                      className="w-32"
                    />
                    <Button type="submit" variant="ghost" size="sm">
                      Complete
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}

        <StartFloorForm
          submit={startFloor.bind(null, id, visitedOn, projectId)}
        />
      </section>

      {/*
        The non-issues table is the majority case, so this is the plain list it
        is. Becoming an issue is offered under each entry and never as part of
        recording one: the exception is a second act, and staying an
        observation is what happens if nothing more is done.
      */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Observations</h2>
          <span className="text-muted-foreground text-sm">
            {visit.observations.length} recorded
          </span>
        </div>

        {visit.observations.length === 0 ? (
          <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
            Nothing observed yet.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {visit.observations.map((observation) => {
              const finding = raisedFrom.get(observation.id);
              const evidence = evidencing.get(observation.id) ?? [];
              const loose = unfiled.get(observation.floor) ?? [];

              return (
                <li key={observation.id} className="space-y-2 px-4 py-3">
                  <div className="text-muted-foreground flex flex-wrap items-baseline gap-3 text-sm">
                    {/*
                      The composed grammar, exactly as the field says it.
                      Rendered by the API from the components, so this screen
                      cannot spell it a second way.
                    */}
                    <span className="text-foreground font-medium">
                      {observation.location}
                    </span>
                    <span className="tabular-nums">
                      {clock(observation.observedAt, zone)}
                    </span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap">
                    {observation.observed}
                  </p>

                  {/*
                    What evidences it (issue #113, ADR-0056), beside what it
                    evidences — the arrangement the report prints. Through the
                    Next server, never straight at the API.
                  */}
                  {evidence.length > 0 && (
                    <ul className="flex flex-wrap gap-2">
                      {evidence.map((photo) => (
                        <li key={photo.id}>
                          <img
                            src={`/photos/${photo.id}/bytes`}
                            alt={photo.filename}
                            className="bg-muted size-16 rounded-md border object-cover"
                          />
                        </li>
                      ))}
                    </ul>
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
                    Promoting is the deliberate exception, so it is a small
                    control under an observation rather than a step in
                    recording one — the non-issues table is the majority case
                    and stays the default path.
                  */}
                  {finding === undefined ? (
                    <div className="flex flex-wrap items-start gap-2 pt-1">
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
                  ) : (
                    <Link
                      href={`/projects/${projectId}/issues/${finding.number}`}
                      className="inline-flex items-center gap-2 pt-1"
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
                      <span className="text-muted-foreground hover:text-foreground text-sm transition-colors">
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
      </section>

      {/*
        The walk's **conversation** (issue #114, ADR-0058): what the engineer
        captured, spoken or typed, and what the agent proposed back. Speaking
        and typing are two ways into one record, which is why they sit in one
        card and not two — ADR-0025 asks for field capture designed for a thumb,
        and which hand is free is the only thing that decides between them.
      */}
      <Card>
        <CardHeader>
          <CardTitle>Capture what you see</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <VoiceRecorder
            siteVisitId={id}
            add={addRecording.bind(null, id, projectId)}
          />
          <div className="border-t pt-6">
            <TypeATurn submit={typeATurn.bind(null, id, projectId)} />
          </div>
        </CardContent>
      </Card>

      {/*
        The conversation itself. A capture is a **draft** until the engineer has
        read it and confirmed it — so nothing here has written an observation,
        and the list above stays what was actually recorded.
      */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Conversation</h2>
          {/*
            Live over SSE, so a slow transcription and a slow model both read
            as working rather than as broken — and so the agent's reply and the
            drafts below appear without a reload.
          */}
          <ConversationProgress
            siteVisitId={id}
            initial={visit.conversation.turns}
            initialRuns={visit.conversation.runs}
          />
        </div>

        {visit.conversation.turns.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {visit.conversation.turns.map((turn) => {
              // The agent's turn: a proposal read beside what it answers, and
              // never a draft anybody confirms here. Confirming happens on the
              // capture above it, which is where `observation_id` is stamped.
              if (turn.speaker === 'AGENT') {
                return (
                  <li
                    key={turn.id}
                    className="bg-muted/40 space-y-2 px-4 py-3"
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <Badge variant="outline">Proposed</Badge>
                      <span className="text-muted-foreground text-sm">
                        The agent read the capture above.
                      </span>
                    </div>
                    {turn.proposal === null ? (
                      // A field it could not propose, so it asked instead. The
                      // answer is the next capture and never an edit to this.
                      <p className="text-sm whitespace-pre-wrap">
                        {turn.transcript}
                      </p>
                    ) : (
                      <div className="space-y-1">
                        {/*
                          The composed grammar, exactly as the API renders it —
                          this screen cannot spell it a second way (ADR-0030).
                          It read `Floor 3 — South stair, A` while it did,
                          against the record's `Side A`.
                        */}
                        <p className="text-muted-foreground text-sm">
                          {turn.proposal.location}
                        </p>
                        <p className="text-sm whitespace-pre-wrap">
                          {turn.proposal.observed}
                        </p>
                        {turn.proposal.issueId !== null && (
                          <p className="text-muted-foreground text-sm">
                            {/*
                              Read as another sighting, and proposed only: a
                              sighting burns an identifier that is never given
                              back (ADR-0031), so promoting stays the second act
                              under the observation once it exists.
                            */}
                            Reads as another sighting of{' '}
                            {issues.find(
                              (issue) => issue.id === turn.proposal!.issueId,
                            )?.number === undefined
                              ? 'a finding on this job'
                              : `Issue ${
                                  issues.find(
                                    (issue) =>
                                      issue.id === turn.proposal!.issueId,
                                  )!.number
                                }`}
                            .
                          </p>
                        )}
                      </div>
                    )}
                  </li>
                );
              }

              // The engineer's capture. Where the agent has answered it, the
              // confirm form below is seeded with what it proposed.
              const answer = visit.conversation.turns.find(
                (one) =>
                  one.speaker === 'AGENT' && one.position === turn.position + 1,
              );
              const evidence =
                turn.observation === null
                  ? []
                  : (evidencing.get(turn.observation.id) ?? []);
              const loose =
                turn.observation === null
                  ? []
                  : (unfiled.get(turn.observation.floor) ?? []);

              return (
                <li key={turn.id} className="space-y-3 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-muted-foreground text-sm tabular-nums">
                      {turn.recordedAt === null
                        ? ''
                        : clock(turn.recordedAt, zone)}
                    </span>
                    <CaptureState capture={turn} />
                    {turn.kind === 'VOICE' && (
                      /*
                        Through the Next server, never straight at the API — the
                        same reason a photograph's bytes are proxied. This is
                        also half of what makes a failed transcription
                        recoverable: the engineer listens and writes it down.
                      */
                      <audio
                        controls
                        preload="none"
                        src={`/turns/${turn.id}/audio`}
                        className="h-9 min-w-48 flex-1"
                      />
                    )}
                  </div>

                  {/*
                    What was captured, verbatim — on a typed turn it is there
                    from the first instant, and on a spoken one it arrives with
                    the vendor. Shown above the form rather than only inside it,
                    because the form's box is the engineer's correction and this
                    is what they are correcting *from*.
                  */}
                  {turn.kind === 'TYPED' && turn.transcript !== null && (
                    <p className="text-sm whitespace-pre-wrap">
                      {turn.transcript}
                    </p>
                  )}

                  {/*
                    Offered on *queued* as well as on a failure, because a
                    recording can sit queued with no job behind it: Redis has no
                    volume in this stack, so a job can be lost while its row
                    cannot. That is the case the retry route names in its own
                    comment, and it was the one case the screen had no button
                    for. Not offered while it is transcribing, which is a vendor
                    genuinely working — nor on a typed turn, which never waited
                    on one.
                  */}
                  {turn.kind === 'VOICE' &&
                    (turn.failure !== null || turn.state === 'queued') &&
                    turn.observation === null && (
                      <div className="flex flex-wrap items-center gap-3">
                        {turn.failure !== null && (
                          <p className="text-destructive text-sm">
                            {turn.failure}
                          </p>
                        )}
                        <form
                          action={retryTranscription.bind(
                            null,
                            turn.id,
                            id,
                            projectId,
                          )}
                        >
                          <Button type="submit" variant="ghost" size="sm">
                            Ask again
                          </Button>
                        </form>
                      </div>
                    )}

                  {turn.observation !== null ? (
                    <div className="space-y-2">
                      <div className="space-y-1">
                        <p className="text-muted-foreground text-sm">
                          {turn.observation.location}
                        </p>
                        <p className="text-sm whitespace-pre-wrap">
                          {turn.observation.observed}
                        </p>
                      </div>

                      {/*
                        What already evidences it, and the floor's unfiled
                        photographs to bind — the confirmed draft's shortlist
                        (ADR-0057 part 5, by ADR-0056's mechanism). Here as well
                        as under the observation above, because this is the
                        screen the engineer is looking at when they confirm.
                      */}
                      {evidence.length > 0 && (
                        <ul className="flex flex-wrap gap-2">
                          {evidence.map((photo) => (
                            <li key={photo.id}>
                              <img
                                src={`/photos/${photo.id}/bytes`}
                                alt={photo.filename}
                                className="bg-muted size-16 rounded-md border object-cover"
                              />
                            </li>
                          ))}
                        </ul>
                      )}
                      {loose.length > 0 && (
                        <EvidenceShortlist
                          photos={loose}
                          timeZone={zone}
                          bind={bindPhotoToObservation.bind(
                            null,
                            turn.observation.id,
                            id,
                            projectId,
                          )}
                        />
                      )}
                    </div>
                  ) : isWorking(turn) ? (
                    <p className="text-muted-foreground text-sm">
                      Waiting for the transcript. The audio is already stored.
                    </p>
                  ) : (
                    <DraftObservationForm
                      transcript={turn.transcript}
                      proposal={answer?.proposal ?? null}
                      submit={commitTurn.bind(
                        null,
                        turn.id,
                        id,
                        visitedOn,
                        projectId,
                      )}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Or type an observation</CardTitle>
        </CardHeader>
        <CardContent>
          <ObservationForm
            submit={recordObservation.bind(null, id, visitedOn, projectId)}
          />
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Photographs</h2>
          <span className="text-muted-foreground text-sm">
            {visit.photos.length === 0
              ? 'none yet'
              : `${visit.photos.length} on this walk`}
          </span>
        </div>

        {unevidenced.length > 0 && (
          <div className="border-destructive/40 bg-destructive/5 space-y-2 rounded-lg border p-4">
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
                    <span className="text-muted-foreground hover:text-foreground text-sm transition-colors">
                      {finding.category}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {visit.photos.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {visit.photos.map((photo) => (
              <li
                key={photo.id}
                className="flex flex-wrap items-center gap-4 px-4 py-3"
              >
                {/*
                  Through the Next server, never straight at the API. The bin
                  cannot be seen to be wrong without seeing the photograph, so
                  this is what makes a two-second correction possible at all.
                */}
                <img
                  src={`/photos/${photo.id}/bytes`}
                  alt={photo.filename}
                  className="bg-muted size-16 shrink-0 rounded-md border object-cover"
                />
                <div className="min-w-48 flex-1 space-y-0.5">
                  <p className="text-sm font-medium break-all">
                    {photo.filename}
                  </p>
                  <p className="text-muted-foreground text-sm tabular-nums">
                    {clock(photo.takenAt, zone)}
                    {/*
                      Unfiled is about what it evidences and not about the
                      floor (issue #113, ADR-0056): a photograph on a floor and
                      nothing else prints nowhere, so the floor is no longer
                      half of what makes this worth saying. The floor's own
                      answer is the select beside it.
                    */}
                    {photo.observationId === null && photo.issueNumber === null
                      ? ' · unfiled'
                      : ''}
                  </p>
                </div>
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
              </li>
            ))}
          </ul>
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Add the walk&rsquo;s photographs</CardTitle>
        </CardHeader>
        <CardContent>
          <PhotoForm add={addPhoto.bind(null, id, projectId)} timeZone={zone} />
        </CardContent>
      </Card>

      {/*
        The write-up, last on the page because it is the last thing that
        happens on a walk — and after the photographs, because the warning
        above is what story 66 asks be read *before* a report is generated.

        Generating again is another report and never an edit: a finding that
        had no photograph gets one, and this button is pressed a second time.
      */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Report</h2>
          <ReportProgress siteVisitId={id} initial={visit.reports} />
        </div>

        {visit.reports.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {visit.reports.map((report) => (
              <li
                key={report.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3"
              >
                <ReportState report={report} />
                <span className="text-muted-foreground text-sm">
                  {clock(report.createdAt, zone)}
                </span>
                {report.state === 'rendered' && (
                  <a
                    href={`/site-visit-reports/${report.id}/pdf`}
                    target="_blank"
                    rel="noopener"
                    className="text-sm font-medium underline underline-offset-4"
                  >
                    Open the PDF
                  </a>
                )}
                {report.failure !== null && (
                  <span className="text-destructive text-sm">
                    {report.failure}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        <form action={generate}>
          <Button type="submit" variant="secondary">
            {visit.reports.length === 0
              ? 'Generate the report'
              : 'Generate it again'}
          </Button>
        </form>
      </section>

      <p className="text-muted-foreground text-sm">
        Visit recorded {day(visit.createdAt, zone)}.
      </p>
    </div>
  );
}
