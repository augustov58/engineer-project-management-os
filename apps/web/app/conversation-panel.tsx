import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  CaptureState,
  ConversationProgress,
  DraftObservationForm,
  TypeATurn,
  VoiceRecorder,
} from './conversation';
import { EvidenceShortlist } from './photo-form';
import { SectionHead } from './section-head';
import { clock } from './wall-clock';
import type { AddState, CaptureRefusal } from './actions';
import {
  isWorking,
  type CaptureRun,
  type Issue,
  type Photo,
  type Turn,
} from './api';

/**
 * The walk's conversation, as one component (issue #118; the approved design
 * brief's `## The conversation panel`, plate F-03).
 *
 * ADR-0058 needs this on two records and ADR-0059 point 2 put the component in
 * the brief rather than in either ticket. Lifted out of the 847-line site visit
 * screen so that the project chat's ticket has a panel to reach for rather than
 * a second rendering to write; **only the visit is wired here**, because the
 * project-level conversations are that ticket's and nothing in this one writes
 * one. The slot that would differ is the commit — an observation on a visit, an
 * assumption record on a project — and it is deliberately not parameterised
 * until there is a second caller to parameterise it for.
 *
 * Anatomy, top to bottom, which is the brief's: **head** with the run state,
 * **turns** in `position` order, **the commit** inline under the agent turn
 * that proposed it, and **one capture bar** holding spoken and typed. A server
 * component: every live part of it is already its own client island, and the
 * turns have to be in the server's first paint (ADR-0028).
 */
export function ConversationPanel({
  id,
  siteVisitId,
  turns,
  runs,
  issues,
  timeZone,
  evidencing,
  unfiled,
  add,
  typed,
  commit,
  retry,
  bindEvidence,
}: {
  /** The jumper's anchor. */
  id: string;
  siteVisitId: string;
  /** In `position` order, which is the order the API returns them in. */
  turns: Turn[];
  runs: CaptureRun[];
  /** The job's register, so a proposed sighting reads as the finding it names. */
  issues: Issue[];
  /** The zone of the building, which is what these times are read in. */
  timeZone: string;
  /** What evidences each observation, keyed by the observation. */
  evidencing: Map<string, Photo[]>;
  /** What is unfiled on each floor, keyed by the floor's value. */
  unfiled: Map<string, Photo[]>;
  add: (
    captureKey: string,
    recordedAt: string,
    audio: File,
  ) => Promise<CaptureRefusal | undefined>;
  typed: (previous: AddState, formData: FormData) => Promise<AddState>;
  /** Bound per turn: the confirm writes the observation onto that capture. */
  commit: (
    turnId: string,
  ) => (previous: AddState, formData: FormData) => Promise<AddState>;
  retry: (turnId: string) => (formData: FormData) => void;
  bindEvidence: (observationId: string) => (formData: FormData) => void;
}) {
  return (
    <section id={id} className="grid scroll-mt-14 gap-3">
      <SectionHead
        aside={
          /*
            Live over SSE, so a slow transcription and a slow model both read as
            working rather than as broken — and so the agent's reply and the
            drafts below appear without a reload.
          */
          <ConversationProgress
            siteVisitId={siteVisitId}
            initial={turns}
            initialRuns={runs}
          />
        }
      >
        Conversation
      </SectionHead>

      {turns.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {turns.map((turn) => {
            // The agent's turn: a proposal read beside what it answers, and
            // the slot the **commit** sits in. The confirm is still stamped on
            // the engineer's capture — the route refuses an agent turn by name
            // — so the form is rendered here and bound to the turn below.
            if (turn.speaker === 'AGENT') {
              const answered = turns.find(
                (one) =>
                  one.speaker === 'ENGINEER' && one.position === turn.position - 1,
              );

              return (
                <li key={turn.id} className="bg-muted/40 grid gap-2 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">Proposed</Badge>
                    <span className="text-muted-foreground text-xs">
                      The agent read the capture above.
                    </span>
                  </div>

                  {turn.proposal === null ? (
                    // A field it could not propose, so it asked instead. The
                    // answer is the next capture and never an edit to this.
                    <p className="text-base whitespace-pre-wrap">
                      {turn.transcript}
                    </p>
                  ) : (
                    <div className="grid gap-1.5">
                      {/*
                        The composed grammar, exactly as the API renders it —
                        this screen cannot spell it a second way (ADR-0030). It
                        read `Floor 3 — South stair, A` while it did, against
                        the record's `Side A`.
                      */}
                      <p className="text-muted-foreground text-xs">
                        {turn.proposal.location}
                      </p>
                      <p className="text-base whitespace-pre-wrap">
                        {turn.proposal.observed}
                      </p>
                      {turn.proposal.issueId !== null && (
                        <p className="text-muted-foreground text-xs">
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
                                  (issue) => issue.id === turn.proposal!.issueId,
                                )!.number
                              }`}
                          .
                        </p>
                      )}
                    </div>
                  )}

                  {/*
                    **The commit**, inline under the turn that proposed it (the
                    brief's anatomy point 3). What it writes is the capture
                    above's observation, so it is seeded with this proposal and
                    bound to that capture's id — and it is offered only while
                    that capture is still a draft.
                  */}
                  {answered !== undefined && answered.observation === null && (
                    <DraftObservationForm
                      transcript={answered.transcript}
                      proposal={turn.proposal}
                      submit={commit(answered.id)}
                    />
                  )}
                </li>
              );
            }

            // The engineer's capture. Where the agent answered it, the commit
            // is under that answer; where it did not — the spoken path, or a
            // run that failed — it is here, because a failed capture is still
            // committable.
            const answer = turns.find(
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
              <li key={turn.id} className="grid min-h-11 gap-2 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {turn.recordedAt === null
                      ? ''
                      : clock(turn.recordedAt, timeZone)}
                  </span>
                  <CaptureState capture={turn} />
                  {turn.kind === 'VOICE' && (
                    /*
                      Through the Next server, never straight at the API — the
                      same reason a photograph's bytes are proxied. This is also
                      half of what makes a failed transcription recoverable: the
                      engineer listens and writes it down.
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
                  What was captured, verbatim, at the Record step — on a typed
                  turn it is there from the first instant, and on a spoken one
                  it arrives with the vendor. Shown above the form rather than
                  only inside it, because the form's box is the engineer's
                  correction and this is what they are correcting *from*.
                */}
                {turn.kind === 'TYPED' && turn.transcript !== null && (
                  <p className="text-base whitespace-pre-wrap">
                    {turn.transcript}
                  </p>
                )}

                {/*
                  Offered on *queued* as well as on a failure, because a
                  recording can sit queued with no job behind it: Redis has no
                  volume in this stack, so a job can be lost while its row
                  cannot. Not offered while it is transcribing, which is a
                  vendor genuinely working — nor on a typed turn, which never
                  waited on one.
                */}
                {turn.kind === 'VOICE' &&
                  (turn.failure !== null || turn.state === 'queued') &&
                  turn.observation === null && (
                    <div className="flex flex-wrap items-center gap-2">
                      {turn.failure !== null && (
                        <p className="text-destructive text-xs">
                          {turn.failure}
                        </p>
                      )}
                      <form action={retry(turn.id)}>
                        <Button
                          type="submit"
                          variant="ghost"
                          className="h-11 px-3"
                        >
                          Ask again
                        </Button>
                      </form>
                    </div>
                  )}

                {turn.observation !== null ? (
                  <div className="grid gap-1.5">
                    <p className="text-muted-foreground text-xs">
                      {turn.observation.location}
                    </p>
                    <p className="text-base whitespace-pre-wrap">
                      {turn.observation.observed}
                    </p>

                    {/*
                      What already evidences it, and the floor's unfiled
                      photographs to bind — the confirmed draft's shortlist
                      (ADR-0057 part 5, by ADR-0056's mechanism). Here as well
                      as under the observation above, because this is the screen
                      the engineer is looking at when they confirm.
                    */}
                    {evidence.length > 0 && (
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
                    )}
                    {loose.length > 0 && (
                      <EvidenceShortlist
                        photos={loose}
                        timeZone={timeZone}
                        bind={bindEvidence(turn.observation.id)}
                      />
                    )}
                  </div>
                ) : isWorking(turn) ? (
                  <p className="text-muted-foreground text-xs">
                    Waiting for the transcript. The audio is already stored.
                  </p>
                ) : (
                  answer === undefined && (
                    <DraftObservationForm
                      transcript={turn.transcript}
                      proposal={null}
                      submit={commit(turn.id)}
                    />
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/*
        **The capture bar**: record, and type, in one bar (the brief's anatomy
        point 4). Spoken and typed are one record (ADR-0057) and the bar says so
        by being one control group rather than a card with a rule across it —
        which is what the two of them were until this ticket. At the foot of the
        panel, so the primary action of the walk stays within thumb reach of the
        bottom of the viewport (density rule 7).
      */}
      <div className="grid gap-2 rounded-lg border p-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <div className="sm:w-44 sm:shrink-0">
            <VoiceRecorder siteVisitId={siteVisitId} add={add} />
          </div>
          <div className="min-w-0 flex-1">
            <TypeATurn submit={typed} />
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          Spoken or typed, it is one capture. Confirming is yours; the agent
          never writes the record.
        </p>
      </div>
    </section>
  );
}
