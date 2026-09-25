import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  CaptureState,
  ConfirmAssumptionRecord,
  DraftObservationForm,
  TypeATurn,
  VoiceRecorder,
} from './conversation';
import { Evidence } from './evidence';
import { EvidenceShortlist } from './photo-form';
import { SectionHead } from './section-head';
import { clock } from './wall-clock';
import type { AddState, CaptureRefusal } from './actions';
import {
  isWorking,
  type Issue,
  type Photo,
  type Turn,
} from './api';
import type { ReactNode } from 'react';

/**
 * The finding a proposal reads as another sighting of, named.
 *
 * The register is scanned once and not twice, and the fallback is the sentence
 * rather than a blank: a proposal naming a finding this screen cannot see is
 * still a proposal about a finding.
 */
function sighted(issues: Issue[], issueId: string): string {
  const found = issues.find((issue) => issue.id === issueId);
  return found === undefined ? 'a finding on this job' : `Issue ${found.number}`;
}

/**
 * The conversation, as one component (issue #118; the approved design brief's
 * `## The conversation panel`, plate F-03).
 *
 * ADR-0058 needs this on two records and ADR-0059 point 2 put the component in
 * the brief rather than in either ticket. **Both are wired since issue #121**,
 * and the brief's sentence held: *"one component, two contexts, and the only
 * difference is what it proposes"*.
 *
 * Almost all of that difference is **data and not a prop**. A project turn has
 * no `kind`, so it renders no audio control, no capture state and no *Ask
 * again*; an agent turn carries a `proposal` or a `proposedAssumptionRecord`
 * and never both, so which commit sits under it is read off the turn. What is
 * genuinely the caller's is three things: the live summary, whose words are
 * each screen's own; the recorder, which is a walk's and needs the walk's id;
 * and the bound commit action, which is the slot the brief names.
 *
 * Anatomy, top to bottom, which is the brief's: **head** with the run state,
 * **turns** in `position` order, **the commit** inline under the agent turn
 * that proposed it, and **one capture bar**. A server component: every live
 * part of it is already its own client island, and the turns have to be in the
 * server's first paint (ADR-0028).
 */
/**
 * What a **walk** brings to the panel and a project does not: the recording, the
 * evidence and the commit that writes an observation (issue #121).
 *
 * One optional object rather than six optional props, and `walk === undefined`
 * is the whole of *this is a project's conversation* — no second flag beside it.
 * They were six required props before, and the project record passed six inert
 * values to satisfy a shape it has no part in: an empty `Map`, an `add` that
 * resolves, a `commit` that returns nothing. Six lies at a call site are six
 * things a reader has to check are lies, where an absent object says what it is.
 */
interface OnAWalk {
  /** What the recorder holds its audio under. */
  siteVisitId: string;
  /** What evidences each observation, keyed by the observation. */
  evidencing: Map<string, Photo[]>;
  /** What is unfiled on each floor, keyed by the floor's value. */
  unfiled: Map<string, Photo[]>;
  add: (
    captureKey: string,
    recordedAt: string,
    audio: File,
  ) => Promise<CaptureRefusal | undefined>;
  /** Bound per turn: the confirm writes the observation onto that capture. */
  commit: (
    turnId: string,
  ) => (previous: AddState, formData: FormData) => Promise<AddState>;
  retry: (turnId: string) => (formData: FormData) => void;
  bindEvidence: (observationId: string) => (formData: FormData) => void;
}

export function ConversationPanel({
  anchor,
  walk,
  turns,
  live,
  issues,
  timeZone,
  typed,
  typedPlaceholder,
  typedLabel,
  hint,
  confirmRecord,
  submissions = [],
}: {
  /** The jumper's anchor — a fragment name, never the record's id. */
  anchor: string;
  /** The walk this conversation is on, or absent on a project's. */
  walk?: OnAWalk;
  /** In `position` order, which is the order the API returns them in. */
  turns: Turn[];
  /** The head's live summary: each screen's own words over the same stream. */
  live: ReactNode;
  /** The job's register, so a proposed sighting reads as the finding it names. */
  issues: Issue[];
  /** The zone of the building, which is what these times are read in. */
  timeZone: string;
  typed: (previous: AddState, formData: FormData) => Promise<AddState>;
  typedPlaceholder?: string;
  typedLabel?: string;
  /** The one sentence under the bar, which says what this panel commits. */
  hint: ReactNode;
  /**
   * Bound per turn: the confirm writes the assumption record the agent
   * proposed on **that** turn. Absent on a walk, which proposes none.
   */
  confirmRecord?: (
    turnId: string,
  ) => (previous: AddState, formData: FormData) => Promise<AddState>;
  /** The job's issuances, so a proposed record can be pointed at one. */
  submissions?: { id: string; revision: string; phaseName: string }[];
}) {
  // Read once, so the `position` ± 1 pairing below is a lookup rather than a
  // scan of every turn for every turn.
  const byPosition = new Map(turns.map((turn) => [turn.position, turn]));

  return (
    <section id={anchor} className="grid scroll-mt-14 gap-3">
      {/*
        Live over SSE, so a slow transcription and a slow model both read as
        working rather than as broken — and so the agent's reply and the forms
        below appear without a reload. **The caller's**, because the words
        differ: a walk counts captures and transcriptions, a project counts
        questions and has no vendor.
      */}
      <SectionHead aside={live}>Conversation</SectionHead>

      {turns.length > 0 && (
        <TurnList capped={walk === undefined}>
          {turns.map((turn) => {
            /*
              The capture an agent turn answers, and the answer to a capture:
              one convention, `position` ± 1, read out of `byPosition` above.
              It was written twice in opposite directions, each `find` running
              inside this `map` — two places for the pairing rule to drift, and
              a scan per turn.
            */
            const neighbour = (offset: number, speaker: Turn['speaker']) => {
              const found = byPosition.get(turn.position + offset);
              return found?.speaker === speaker ? found : undefined;
            };
            // The agent's turn: a proposal read beside what it answers, and
            // the slot the **commit** sits in. The confirm is still stamped on
            // the engineer's capture — the route refuses an agent turn by name
            // — so the form is rendered here and bound to the turn below.
            if (turn.speaker === 'AGENT') {
              const answered = neighbour(-1, 'ENGINEER');

              return (
                <li key={turn.id} className="bg-muted/40 grid gap-2 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">Proposed</Badge>
                    <span className="text-muted-foreground text-xs">
                      {walk === undefined
                        ? 'The agent read the job.'
                        : 'The agent read the capture above.'}
                    </span>
                  </div>

                  {turn.proposal === null &&
                  turn.proposedAssumptionRecord === null ? (
                    // A field it could not propose, so it asked instead. The
                    // answer is the next capture and never an edit to this.
                    <p className="text-base whitespace-pre-wrap">
                      {turn.transcript}
                    </p>
                  ) : turn.proposedAssumptionRecord !== null &&
                    turn.assumptionRecord !== null ? (
                    /*
                      The proposal, **once it has been captured** (issue #121).
                      Read-only and monospaced, because the two leading spaces
                      and the sigils are part of what the helper printed and a
                      proportional re-flow is a different document (ADR-0029).
                      What is read here is the *proposal* and not the record it
                      became: the record is the submission's, and the engineer
                      may have edited a line on the way.

                      **Only once captured.** While it is still a proposal the
                      form below is the reading — printing twenty-five lines of
                      blocks twice, once to read and once to edit, was 600 px of
                      the same text on a 390 px screen and read as two different
                      things.
                    */
                    <div className="grid gap-1.5">
                      <p className="text-muted-foreground text-xs">
                        Assumptions
                      </p>
                      <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap">
                        {turn.proposedAssumptionRecord.assumptions}
                      </pre>
                      <p className="text-muted-foreground text-xs">
                        Flags / verify
                      </p>
                      <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap">
                        {turn.proposedAssumptionRecord.flags}
                      </pre>
                      <p className="text-muted-foreground text-xs">
                        Code edition
                      </p>
                      <p className="text-base">
                        {turn.proposedAssumptionRecord.codeEdition}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        Captured against the issuance you chose.
                      </p>
                    </div>
                  ) : turn.proposal !== null ? (
                    <div className="grid gap-1.5">
                      {/* Named once: the same scan ran twice, under two `!`s. */}
                      {/*
                        Labelled, as the plate draws them: a proposal is two
                        fields and the engineer is about to confirm both, so the
                        location is not left to be told apart from the words by
                        its size alone.

                        The composed grammar, exactly as the API renders it —
                        this screen cannot spell it a second way (ADR-0030). It
                        read `Floor 3 — South stair, A` while it did, against
                        the record's `Side A`.
                      */}
                      <p className="text-muted-foreground text-xs">Location</p>
                      <p className="text-base">{turn.proposal.location}</p>
                      <p className="text-muted-foreground text-xs">Observed</p>
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
                          {sighted(issues, turn.proposal.issueId)}.
                        </p>
                      )}
                    </div>
                  ) : null}

                  {/*
                    **The commit** for a proposed assumption record, inline
                    under the turn that proposed it and bound to that turn:
                    what it writes is the record, and the turn is its
                    provenance (ADR-0058 part 4). Offered only while the
                    proposal is still one — a confirmed turn has a record, and
                    a second confirm is refused by the record itself. Where
                    there is one, the blocks above are the reading and there is
                    nothing left to submit.
                  */}
                  {turn.proposedAssumptionRecord !== null &&
                    turn.assumptionRecord === null &&
                    confirmRecord !== undefined && (
                      <ConfirmAssumptionRecord
                        turnId={turn.id}
                        proposal={turn.proposedAssumptionRecord}
                        submissions={submissions}
                        submit={confirmRecord(turn.id)}
                      />
                    )}

                  {/*
                    **The commit**, inline under the turn that proposed it (the
                    brief's anatomy point 3). What it writes is the capture
                    above's observation, so it is seeded with this proposal and
                    bound to that capture's id — and it is offered only while
                    that capture is still a draft.

                    **Only where there is a proposal.** An agent turn is the
                    draft's fields *or* its one question and never both, so a
                    turn that asked one proposed nothing: the commit stays under
                    the capture, where a form under the question would read as
                    though the question were the draft.
                  */}
                  {turn.proposal !== null &&
                    walk !== undefined &&
                    answered !== undefined &&
                    answered.observation === null && (
                      <DraftObservationForm
                        transcript={answered.transcript}
                        proposal={turn.proposal}
                        submit={walk.commit(answered.id)}
                      />
                    )}
                </li>
              );
            }

            // The engineer's capture. Where the agent **proposed** against it,
            // the commit is under that proposal; where it did not — the spoken
            // path, a run that failed, or a turn that asked a question rather
            // than proposing — it is here, because a failed capture is still
            // committable and a question is answered by the next capture.
            const answer = neighbour(1, 'AGENT');
            const proposed = answer !== undefined && answer.proposal !== null;
            const evidence =
              turn.observation === null || walk === undefined
                ? []
                : (walk.evidencing.get(turn.observation.id) ?? []);
            const loose =
              turn.observation === null || walk === undefined
                ? []
                : (walk.unfiled.get(turn.observation.floor) ?? []);

            return (
              <li key={turn.id} className="grid min-h-11 gap-2 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  {/*
                    When it was made. A capture carries the instant the engineer
                    was standing there and a question carries only when it was
                    written down, so a project turn reads from `createdAt` —
                    one expression, because two components would be two places
                    to answer *when was this said*.
                  */}
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {clock(turn.recordedAt ?? turn.createdAt, timeZone)}
                  </span>
                  {turn.kind !== null && <CaptureState capture={turn} />}
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
                {turn.kind !== 'VOICE' && turn.transcript !== null && (
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
                  walk !== undefined &&
                  (turn.failure !== null || turn.state === 'queued') &&
                  turn.observation === null && (
                    <div className="flex flex-wrap items-center gap-2">
                      {/*
                        A failure the engineer has to read and act on, not the
                        Meta step: every refusal in this product is Body, 14 px,
                        and this is the vendor's own words about a recording
                        that has to be written up by hand.
                      */}
                      {turn.failure !== null && (
                        <p className="text-destructive text-sm">
                          {turn.failure}
                        </p>
                      )}
                      <form action={walk.retry(turn.id)}>
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

                {walk === undefined ? null : turn.observation !== null ? (
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
                    <Evidence photos={evidence} />
                    {loose.length > 0 && (
                      <EvidenceShortlist
                        photos={loose}
                        timeZone={timeZone}
                        bind={walk.bindEvidence(turn.observation.id)}
                      />
                    )}
                  </div>
                ) : isWorking(turn) ? (
                  <p className="text-muted-foreground text-xs">
                    Waiting for the transcript. The audio is already stored.
                  </p>
                ) : (
                  !proposed && (
                    <DraftObservationForm
                      transcript={turn.transcript}
                      proposal={null}
                      submit={walk.commit(turn.id)}
                    />
                  )
                )}
              </li>
            );
          })}
        </TurnList>
      )}

      {/*
        **The capture bar**: record, and type, in one bar (the brief's anatomy
        point 4). Spoken and typed are one record (ADR-0057) and the bar says so
        by being one control group rather than a card with a rule across it —
        which is what the two of them were until this ticket. At the foot of the
        panel, so the primary action of the walk stays within thumb reach of the
        bottom of the viewport (density rule 7).
      */}
      <div className="bg-card grid gap-2 rounded-lg border p-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          {/*
            **The recorder is a walk's.** Plate D-02 draws the project chat as
            one text control, and the reason is the record rather than the
            drawing: a project conversation has no capture machinery — no kind,
            no instant, no audio — and nothing transcribes for it. A microphone
            on this bar would be a control with no route behind it.
          */}
          {walk !== undefined && (
            <>
              <div className="sm:w-56 sm:shrink-0">
                <VoiceRecorder siteVisitId={walk.siteVisitId} add={walk.add} />
              </div>
              {/* The plate's `or`: one bar offering two ways into one record. */}
              <p className="text-muted-foreground self-center text-xs">or</p>
            </>
          )}
          <div className="min-w-0 flex-1">
            <TypeATurn
              submit={typed}
              placeholder={typedPlaceholder}
              label={typedLabel}
            />
          </div>
        </div>
        {/*
          One hint for the whole bar, which is why the two static sentences that
          used to sit under the two controls are gone. On a walk it carries
          **both** of their promises: the one the plate draws, and the
          recorder's own — that a capture is a draft the engineer corrects, so a
          misheard word never becomes the record. That second one is ADR-0057's
          whole thesis and dropping it to match the drawn copy would have
          deleted it from the product. The caller's, since the second context
          commits something else.
        */}
        <p className="text-muted-foreground text-xs">{hint}</p>
      </div>
    </section>
  );
}

/**
 * The list of turns, and on a **project** it is a fixed-height list that
 * scrolls (issue #164). A job's conversation grows for as long as the job
 * runs, and at full length it buried the record it was about.
 * `flex-col-reverse` on the scroller is what opens it at the **newest** turn
 * with no script — a reversed flex container starts scrolled to its end — so
 * the panel stays a server component and the turns stay in its first paint
 * (ADR-0028). The list inside keeps its order.
 *
 * A walk's is uncapped: there the conversation is the capture record the
 * engineer is working down, and whether to cap it is a question nobody has
 * answered.
 */
function TurnList({
  capped,
  children,
}: {
  capped: boolean;
  children: ReactNode;
}) {
  if (!capped) {
    return <ul className="bg-card divide-y rounded-lg border">{children}</ul>;
  }
  return (
    // Focusable and named: a region that scrolls is one a keyboard has to reach,
    // and a screen reader announces it by name (issue #158, WCAG 2.1.1).
    <div
      tabIndex={0}
      role="region"
      aria-label="The conversation so far"
      className="bg-card flex max-h-[28rem] flex-col-reverse overflow-y-auto rounded-lg border"
    >
      <ul className="divide-y">{children}</ul>
    </div>
  );
}
