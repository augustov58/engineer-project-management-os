import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  addPhoto,
  addVoiceCapture,
  bindPhotoToFloor,
  bindPhotoToIssue,
  commitVoiceCapture,
  completeFloor,
  endSiteVisit,
  raiseIssue,
  recordObservation,
  reobserveIssue,
  retryVoiceCapture,
  startFloor,
} from '../../actions';
import { getSiteVisit, listIssues, listIssuesWithoutPhotos } from '../../api';
import { RaiseIssueForm, ReobserveForm } from '../../issue-form';
import { clock, day } from '../../open-item';
import { PhotoBindings, PhotoForm } from '../../photo-form';
import { ObservationForm, StartFloorForm } from '../../site-visit-form';
import {
  CaptureProgress,
  CaptureState,
  DraftObservationForm,
  VoiceRecorder,
} from '../../voice-form';

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

  async function end() {
    'use server';
    await endSiteVisit(id, projectId);
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
            {clock(visit.startedAt)}
            {visit.endedAt === null ? '' : ` – ${clock(visit.endedAt)}`}
          </span>
          {visit.endedAt === null && (
            <form action={end}>
              <Button type="submit" variant="ghost" size="sm">
                End the visit
              </Button>
            </form>
          )}
        </div>
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
                  {clock(floor.startedAt)}
                  {floor.completedAt === null
                    ? ''
                    : ` – ${clock(floor.completedAt)}`}
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
                      {clock(observation.observedAt)}
                    </span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap">
                    {observation.observed}
                  </p>

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
                          : ` · closed ${day(finding.closedAt)}`}
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
        Speaking is the point of this ticket and typing is the fallback, so it
        comes first and gets the whole width. ADR-0025: field capture is
        designed for a thumb, and this is the one control on the screen that
        has to be hit without looking.
      */}
      <Card>
        <CardHeader>
          <CardTitle>Speak an observation</CardTitle>
        </CardHeader>
        <CardContent>
          <VoiceRecorder
            siteVisitId={id}
            add={addVoiceCapture.bind(null, id, projectId)}
          />
        </CardContent>
      </Card>

      {/*
        What was said, and what it is waiting on. A recording is a **draft**
        until the engineer has read it and corrected it — so nothing here has
        written an observation, and the list above stays what was actually
        recorded.
      */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Spoken</h2>
          {/*
            Live over SSE, so a slow transcription reads as working rather than
            as broken — and so the drafts below appear without a reload.
          */}
          <CaptureProgress siteVisitId={id} initial={visit.voiceCaptures} />
        </div>

        {visit.voiceCaptures.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {visit.voiceCaptures.map((capture) => (
              <li key={capture.id} className="space-y-3 px-4 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-muted-foreground text-sm tabular-nums">
                    {clock(capture.recordedAt)}
                  </span>
                  <CaptureState capture={capture} />
                  {/*
                    Through the Next server, never straight at the API — the
                    same reason a photograph's bytes are proxied. This is also
                    half of what makes a failed transcription recoverable: the
                    engineer listens and writes it down.
                  */}
                  <audio
                    controls
                    preload="none"
                    src={`/voice-captures/${capture.id}/audio`}
                    className="h-9 min-w-48 flex-1"
                  />
                </div>

                {capture.failure !== null && (
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="text-destructive text-sm">
                      {capture.failure}
                    </p>
                    <form
                      action={retryVoiceCapture.bind(
                        null,
                        capture.id,
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

                {capture.observation !== null ? (
                  <div className="space-y-1">
                    <p className="text-muted-foreground text-sm">
                      {capture.observation.location}
                    </p>
                    <p className="text-sm whitespace-pre-wrap">
                      {capture.observation.observed}
                    </p>
                  </div>
                ) : capture.state === 'queued' ||
                  capture.state === 'transcribing' ? (
                  <p className="text-muted-foreground text-sm">
                    Waiting for the transcript. The audio is already stored.
                  </p>
                ) : (
                  <DraftObservationForm
                    transcript={capture.transcript}
                    submit={commitVoiceCapture.bind(
                      null,
                      capture.id,
                      id,
                      visitedOn,
                      projectId,
                    )}
                  />
                )}
              </li>
            ))}
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
                    {clock(photo.takenAt)}
                    {photo.floor === null && photo.issueNumber === null
                      ? ' · unbound'
                      : ''}
                  </p>
                </div>
                <PhotoBindings
                  floor={photo.floor}
                  floors={floors}
                  issueNumber={photo.issueNumber}
                  issues={issues}
                  bindFloor={bindPhotoToFloor.bind(
                    null,
                    photo.id,
                    id,
                    projectId,
                  )}
                  bindIssue={bindPhotoToIssue.bind(
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
          <PhotoForm add={addPhoto.bind(null, id, projectId)} />
        </CardContent>
      </Card>

      <p className="text-muted-foreground text-sm">
        Visit recorded {day(visit.createdAt)}.
      </p>
    </div>
  );
}
