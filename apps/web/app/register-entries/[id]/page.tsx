import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  attachOpenItemToRegisterEntry,
  createNextRound,
  createOpenItemOnRegisterEntry,
  linkDocumentToRegisterEntry,
  linkSubmission,
  recordDisposition,
  recordHandoff,
  recordResponse,
  setTurnaround,
} from '../../actions';
import {
  currentUser,
  getProject,
  getRegister,
  getRegisterEntry,
  listDocuments,
  listOpenItems,
  listPhases,
  listRegisterEntryDocuments,
  listSubmissions,
  listUsers,
  REGISTER_NAMES,
  REVISE_AND_RESUBMIT,
} from '../../api';
import { Disclosure } from '../../disclosure';
import { LinkDocumentForm } from '../../document-form';
import { LinkedDocumentList } from '../../documents';
import { NewOpenItemForm } from '../../new-open-item-form';
import {
  DispositionForm,
  HandoffForm,
  LinkSubmissionForm,
  NewRegisterEntryForm,
  ResponseForm,
  TurnaroundForm,
} from '../../register-forms';
import { selectClassName } from '../../native-select';
import { OpenItemEntry } from '../../open-item';
import { SectionHead } from '../../section-head';
import { clock, day } from '../../wall-clock';
import { BallInCourtBadge, ClockBadge, inCourtDays } from '../../ball-in-court';

/** The point of this screen is whose court it is in right now. */
export const dynamic = 'force-dynamic';

export default async function RegisterEntryRecord({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const entry = await getRegisterEntry(id);
  if (entry === undefined) {
    notFound();
  }

  const [
    project,
    phases,
    submissions,
    unresolved,
    onTheEntry,
    documents,
    users,
    me,
  ] = await Promise.all([
    getProject(entry.projectId),
    listPhases(entry.projectId),
    listSubmissions(entry.projectId),
    listOpenItems(entry.projectId),
    // What this piece of correspondence arrived with, or was answered by
    // (story 97), and everything on the job it could point at.
    listRegisterEntryDocuments(id),
    listDocuments(entry.projectId),
    // Who a handoff into our court may name, and who it defaults to
    // (issue #112). Everyone at the firm: there are no roles.
    listUsers(),
    currentUser(),
  ]);
  if (project === undefined) {
    notFound();
  }

  // The numbers of the rounds either side of this one: the entry carries
  // their ids, and what anybody quotes is the number. Read only when there is
  // a round to name — the register comes back with every entry it holds, and
  // most entries are the only round there is.
  const rounds =
    entry.previousRoundId === null && entry.nextRoundId === null
      ? undefined
      : await getRegister(entry.registerId);
  const numberById = new Map(
    (rounds?.entries ?? []).map((one) => [one.id, one.number]),
  );
  const held = inCourtDays(entry.inCourtMs);
  const phaseName = new Map(phases.map((phase) => [phase.id, phase.name]));
  const onThisEntry = new Set(entry.openItems.map((item) => item.id));
  const attachable = unresolved.filter((item) => !onThisEntry.has(item.id));
  const answered = submissions.find((one) => one.id === entry.submissionId);
  // Whose it is now and since when. `ballInCourt` **is** the last handoff,
  // projected and derived on every read (ADR-0036); reading `handoffs.at(-1)`
  // beside it would be a second way to answer the same question.
  const current = entry.ballInCourt;
  const unresolvedHere = entry.openItems.filter(
    (item) => item.resolvedAt === null,
  );

  return (
    // The **record** measure (the brief's `## The spacing scale, and the
    // measure`, and plate D-03 draws the screen at 704 px): a register entry is
    // a record being read, and its question and response are prose.
    <div className="max-w-[var(--measure-record)] space-y-6">
      <div>
        <Link
          href={`/registers/${entry.registerId}`}
          className="text-muted-foreground hover:text-foreground font-mono text-xs tracking-[0.06em] uppercase transition-colors"
        >
          &larr; {project.projectNumber} &middot; {REGISTER_NAMES[entry.kind]}
        </Link>
        {/*
          The number in mono and the subject beside it, as plate D-03 draws the
          title. `font-mono` is for identifiers only (the brief's
          `## The type scale`) and an entry's number is one — it is what anybody
          quotes, and the one string on this screen that is never prose.
        */}
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          <span className="font-mono">{entry.number}</span>
          <span className="text-muted-foreground"> &mdash; </span>
          {entry.subject}
        </h1>
        <p className="text-muted-foreground mt-1 text-xs">
          From {entry.fromParty} to {entry.toParty} &middot; logged{' '}
          {day(entry.createdAt, project.timezone)}
          {/*
            Calendar days and never working days, whatever a contract calls
            them: `inCourtMs` sums wall-clock intervals and `inCourtDays` floors
            on a 24-hour day (ADR-0037). The badge below reads `14 / 10 days`
            off the same number, and two words for one unit is how they come to
            disagree.
          */}
          {entry.turnaroundDays !== null &&
            ` · ${entry.turnaroundDays}-day turnaround`}
        </p>
      </div>

      {/*
        The clock, **one line** (the brief's `### Desk`, and plate D-03's
        `.row`). Elapsed in-court time is the sum of the intervals the ball was
        ours, read off the handoffs below and stored nowhere — so time spent
        waiting on somebody else is never counted against us, and this number
        and the clock screen cannot disagree.

        The two badges moved here out of the page head: on the plate the head
        carries the title and its meta and nothing else, and *14 days · over* is
        a reading of the clock rather than a name for the entry.
      */}
      <section className="space-y-3">
        <SectionHead>Clock</SectionHead>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          {/*
            **Always the party's name**, never *our court* in its place — the
            rule `ball-in-court.tsx` states and keeps: whether the ball is ours
            is the stored boolean and not a reading of the name, so a job that
            calls us by the firm's name must still show that name. The badge
            beside this carries the second fact.
          */}
          <span className="text-sm">
            {current === null
              ? 'Unheld'
              : `${current.party} since ${day(current.heldSince, project.timezone)}`}
            {/*
              With no target `ClockBadge` renders nothing — an entry is not past
              anything it has no number for — so the elapsed days would be on the
              screen nowhere at all. Said here in that state only, because with a
              target the badge already prints `{held} / {target} days`.
            */}
            {entry.turnaroundDays === null &&
              ` · ${held} ${held === 1 ? 'day' : 'days'} in our court so far`}
          </span>
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <BallInCourtBadge ballInCourt={entry.ballInCourt} />
            <ClockBadge entry={entry} />
          </span>
        </div>

        {/*
          Only where no target is set, which is the one state the plate does not
          draw and the one where the clock does not yet exist: with a target the
          badge above already prints `{held} / {target} days · over`, and a line
          restating it in words would be the second place the same number lives.
        */}
        {entry.turnaroundDays === null && (
          <TurnaroundForm
            submit={setTurnaround.bind(
              null,
              entry.id,
              entry.registerId,
              project.id,
            )}
          />
        )}
      </section>

      {entry.kind === 'RFI' && (
        <section className="space-y-3">
          <SectionHead>Question and response</SectionHead>
          {/*
            The **Record** step (the brief's `## The type scale`): what was
            written down, at 16/24, rather than at the size of the label above
            it. This is the whole of what the brief means by an entry's subject
            being the record on this screen.
          */}
          <p className="text-base whitespace-pre-wrap">{entry.question}</p>
          {entry.response !== null && (
            <>
              <Separator />
              <p className="text-base whitespace-pre-wrap">{entry.response}</p>
            </>
          )}
          {/*
            Open, for the reason the disposition below is: answering an RFI is
            the act this half of the screen exists for, and density rule 1 is
            about a form that *adds to* a record. The two halves of one screen
            cannot treat the same act two ways.
          */}
          {entry.response === null && (
            <ResponseForm
              submit={recordResponse.bind(
                null,
                entry.id,
                entry.registerId,
                project.id,
              )}
            />
          )}
        </section>
      )}

      {/*
        The outcome of a review, and the round that came back from it. Only a
        submittal is reviewed to a disposition: an RFI is answered, which is
        the section above.

        The form is **not** behind a disclosure and that is bar 4: one submit
        with its two required inputs visible at once, unchanged in count and
        closer to the top than the baseline's 435 px. Density rule 1 is about a
        form that *adds to* a record; this one is the act the screen exists for.
      */}
      {entry.kind === 'SUBMITTAL' && (
        <section className="space-y-3">
          <SectionHead>
            {entry.disposition === null ? 'Record the disposition' : 'Review'}
          </SectionHead>

          {entry.previousRoundId !== null && (
            <p className="text-muted-foreground text-xs">
              Follows{' '}
              <Link
                href={`/register-entries/${entry.previousRoundId}`}
                className="font-mono underline-offset-4 hover:underline"
              >
                {numberById.get(entry.previousRoundId) ?? 'the previous round'}
              </Link>
              .
            </p>
          )}

          {entry.disposition === null ? (
            <>
              <DispositionForm
                users={users}
                me={me?.id ?? ''}
                submit={recordDisposition.bind(
                  null,
                  entry.id,
                  entry.registerId,
                  project.id,
                )}
              />
              {/*
                Said **before** the boundary has to refuse. The baseline's one
                impossible correction was a disposition recorded wrongly — the
                form is gone from the screen once it is set and the API answers
                409, which the screen never predicted, and the word for it was
                *stuck*. The window is named in words here; the **edit path**
                itself is the brief's decision 3, which needs its own ADR and
                has none, so no route moves in this ticket.
              */}
              <p className="text-muted-foreground text-xs">
                One submit: it stops the clock and hands the ball back together.
                After this the entry is append-only &mdash; a change is the next
                round, which points back at this one.
              </p>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant="secondary">{entry.disposition}</Badge>
              {entry.disposedAt !== null && (
                <span className="text-muted-foreground text-xs">
                  {day(entry.disposedAt, project.timezone)}
                </span>
              )}
              <span className="text-muted-foreground text-xs">
                Recorded, so this entry is append-only.
              </span>
            </div>
          )}

          {entry.nextRoundId !== null && (
            <p className="text-muted-foreground text-xs">
              Followed by{' '}
              <Link
                href={`/register-entries/${entry.nextRoundId}`}
                className="font-mono underline-offset-4 hover:underline"
              >
                {numberById.get(entry.nextRoundId) ?? 'the next round'}
              </Link>
              .
            </p>
          )}

          {entry.disposition === REVISE_AND_RESUBMIT &&
            entry.nextRoundId === null && (
              <Disclosure summary="Log the round that comes back">
                <div className="space-y-3">
                  <NewRegisterEntryForm
                    users={users}
                    me={me?.id ?? ''}
                    submit={createNextRound.bind(
                      null,
                      entry.id,
                      entry.registerId,
                      project.id,
                    )}
                    kind="SUBMITTAL"
                    submitLabel="Log the next round"
                    defaultTurnaroundDays={entry.turnaroundDays ?? undefined}
                  />
                  <p className="text-muted-foreground text-xs">
                    A new entry pointing back at this one, which is left
                    exactly as it stands. Its number is yours to give &mdash;
                    nothing here allocates one &mdash; and it starts its own
                    clock from its own first handoff.
                  </p>
                </div>
              </Disclosure>
            )}
        </section>
      )}

      {/*
        The handoffs are the history and there is no state beside them. Whose
        move it is now is the last of these rows, which is what makes a
        turnaround dispute settleable by the record rather than by memory.

        A **compact list** (the brief's `### Desk`): desk row padding, the date
        in tabular numerals so the column reads down.
      */}
      <section className="space-y-3">
        <SectionHead
          aside={
            <span className="tabular-nums">
              {entry.handoffs.length}{' '}
              {entry.handoffs.length === 1 ? 'handoff' : 'handoffs'}
            </span>
          }
        >
          Ball-in-court
        </SectionHead>

        <ul className="bg-card divide-y rounded-lg border">
          {entry.handoffs.map((handoff) => (
            <li
              key={handoff.id}
              className="flex flex-wrap items-baseline gap-3 px-3 py-2"
            >
              <span className="text-muted-foreground font-mono text-xs tabular-nums">
                {day(handoff.heldSince, project.timezone)}{' '}
                {clock(handoff.heldSince, project.timezone)}
              </span>
              <span className="text-sm font-medium">{handoff.party}</span>
              {handoff.inOurCourt && <Badge variant="destructive">Ours</Badge>}
            </li>
          ))}
        </ul>

        <Disclosure summary="Hand the ball on">
          <HandoffForm
            users={users}
            me={me?.id ?? ''}
            submit={recordHandoff.bind(
              null,
              entry.id,
              entry.registerId,
              project.id,
            )}
          />
        </Disclosure>
      </section>

      <Disclosure
        summary={`The issuance that responded (${answered === undefined ? 'none named' : answered.revision})`}
      >
        {answered === undefined ? (
          <div className="space-y-3">
            <p className="text-muted-foreground text-xs">
              Nothing issued on this job has been named as the response.
            </p>
            {submissions.length > 0 && (
              <LinkSubmissionForm
                timeZone={project.timezone}
                submit={linkSubmission.bind(
                  null,
                  entry.id,
                  entry.registerId,
                  project.id,
                )}
                submissions={submissions}
                phaseName={phaseName}
              />
            )}
          </div>
        ) : (
          <Link
            href={`/submissions/${answered.id}`}
            className="hover:bg-muted/50 flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 transition-colors"
          >
            <span className="text-sm font-medium">
              {phaseName.get(answered.phaseId) ?? 'Unknown phase'}
            </span>
            <span className="text-muted-foreground text-xs">
              {answered.revision} &middot; issued{' '}
              {day(answered.issuedAt, project.timezone)} to {answered.recipient}
            </span>
            {answered.currentlyProvisional && (
              <Badge variant="destructive">Provisional</Badge>
            )}
          </Link>
        )}
      </Disclosure>

      {/*
        The submittal package, the marked-up sketch — whatever this entry
        arrived with. Reached through the entry it was logged as, which is the
        whole of retrieval here (ADR-0019).
      */}
      <Disclosure
        summary={`Documents (${onTheEntry.length === 0 ? 'nothing pointed at' : `${onTheEntry.length} pointed at`})`}
      >
        <div className="space-y-3">
          <LinkedDocumentList
            versions={onTheEntry}
            empty="Nothing stored on this job is pointed at from this entry."
          />

          <LinkDocumentForm
            link={linkDocumentToRegisterEntry.bind(
              null,
              entry.id,
              entry.registerId,
              project.id,
            )}
            documents={documents}
            linked={onTheEntry}
            label="A document this entry arrived with"
          />
        </div>
      </Disclosure>

      {/*
        Open while something is outstanding (density rule 3): what is being
        chased for this entry is live work, and the project record keeps its own
        Open items open for the same reason. Collapsed once there is nothing
        unresolved, which is when the section is finished.
      */}
      <Disclosure
        summary={`Open items (${unresolvedHere.length} unresolved)`}
        open={unresolvedHere.length > 0}
      >
        <div className="space-y-3">
          {entry.openItems.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              Nothing is being chased for this entry.
            </p>
          ) : (
            <ul className="space-y-3">
              {entry.openItems.map((item) => (
                <OpenItemEntry
                  users={users}
                  timeZone={project.timezone}
                  key={item.id}
                  item={item}
                  projectId={project.id}
                />
              ))}
            </ul>
          )}

          {attachable.length > 0 && (
            <form
              action={attachOpenItemToRegisterEntry.bind(
                null,
                entry.id,
                entry.registerId,
                project.id,
              )}
              className="bg-card flex flex-wrap items-end gap-2 rounded-lg border p-3"
            >
              {/* Native, because the action reads this out of FormData. */}
              <select
                name="openItemId"
                aria-label="An open item being chased for this entry"
                className={`${selectClassName} min-w-56 flex-1`}
                defaultValue=""
              >
                <option value="" disabled>
                  An open item already on this job&hellip;
                </option>
                {attachable.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.unresolved}
                  </option>
                ))}
              </select>
              <Button type="submit" variant="secondary">
                Attach
              </Button>
            </form>
          )}

          <Disclosure summary="Raise an open item on this entry">
            <div className="space-y-3">
              <NewOpenItemForm
                submit={createOpenItemOnRegisterEntry.bind(
                  null,
                  entry.id,
                  entry.registerId,
                  project.id,
                )}
                submitLabel="Raise it"
              />
              <p className="text-muted-foreground text-xs">
                It stays on {project.projectNumber} and appears in the pending
                items view like everything else &mdash; being chased for a
                register entry is not somewhere else to look.
              </p>
            </div>
          </Disclosure>
        </div>
      </Disclosure>
    </div>
  );
}
