import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
  getProject,
  getRegister,
  getRegisterEntry,
  listDocuments,
  listOpenItems,
  listPhases,
  listRegisterEntryDocuments,
  listSubmissions,
  REGISTER_NAMES,
  REVISE_AND_RESUBMIT,
} from '../../api';
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
import { clock, day, OpenItemEntry } from '../../open-item';
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

  const [project, phases, submissions, unresolved, onTheEntry, documents] =
    await Promise.all([
      getProject(entry.projectId),
      listPhases(entry.projectId),
      listSubmissions(entry.projectId),
      listOpenItems(entry.projectId),
      // What this piece of correspondence arrived with, or was answered by
      // (story 97), and everything on the job it could point at.
      listRegisterEntryDocuments(id),
      listDocuments(entry.projectId),
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

  return (
    <div className="space-y-8">
      <div>
        <Link
          href={`/registers/${entry.registerId}`}
          className="text-muted-foreground hover:text-foreground text-sm transition-colors"
        >
          &larr; {project.projectNumber} {REGISTER_NAMES[entry.kind]}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Badge variant="outline" className="font-mono">
            {entry.number}
          </Badge>
          <h1 className="text-2xl font-medium">{entry.subject}</h1>
          <BallInCourtBadge ballInCourt={entry.ballInCourt} />
          <ClockBadge entry={entry} />
        </div>
        <p className="text-muted-foreground mt-1 text-sm">
          From {entry.fromParty} to {entry.toParty} &middot; logged{' '}
          {day(entry.createdAt)}
        </p>
      </div>

      {/*
        The clock. Elapsed in-court time is the sum of the intervals the ball
        was ours, read off the handoffs below and stored nowhere — so time
        spent waiting on somebody else is never counted against us, and this
        number and the clock screen cannot disagree.
      */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Clock</h2>
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-3 rounded-lg border p-4">
          <p className="text-sm">
            <span className="text-xl font-medium tabular-nums">{held}</span>{' '}
            <span className="text-muted-foreground">
              {held === 1 ? 'day' : 'days'} in our court
            </span>
          </p>
          {entry.turnaroundDays === null ? (
            <TurnaroundForm
              submit={setTurnaround.bind(
                null,
                entry.id,
                entry.registerId,
                project.id,
              )}
            />
          ) : (
            <p
              className={
                entry.pastClock
                  ? 'text-destructive text-sm font-medium'
                  : 'text-muted-foreground text-sm'
              }
            >
              {entry.pastClock
                ? `Past its clock — the target is ${entry.turnaroundDays} days.`
                : `Against a ${entry.turnaroundDays}-day turnaround.`}
            </p>
          )}
        </div>
      </section>

      {entry.kind === 'RFI' && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Question and response</h2>
          <div className="space-y-3 rounded-lg border p-4">
            <p className="whitespace-pre-wrap">{entry.question}</p>
            {entry.response !== null && (
              <>
                <Separator />
                <p className="whitespace-pre-wrap">{entry.response}</p>
              </>
            )}
          </div>
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
      */}
      {entry.kind === 'SUBMITTAL' && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Review</h2>

          {entry.previousRoundId !== null && (
            <p className="text-muted-foreground text-sm">
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
              <p className="text-muted-foreground text-sm">
                Recording the outcome stops the clock and hands the ball back,
                in one action.
              </p>
              <DispositionForm
                submit={recordDisposition.bind(
                  null,
                  entry.id,
                  entry.registerId,
                  project.id,
                )}
              />
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border p-4">
              <Badge variant="secondary">{entry.disposition}</Badge>
              {entry.disposedAt !== null && (
                <span className="text-muted-foreground text-sm">
                  {day(entry.disposedAt)}
                </span>
              )}
            </div>
          )}

          {entry.nextRoundId !== null && (
            <p className="text-muted-foreground text-sm">
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
              <Card>
                <CardHeader>
                  <CardTitle>Log the round that comes back</CardTitle>
                </CardHeader>
                <CardContent>
                  <NewRegisterEntryForm
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
                  <p className="text-muted-foreground mt-3 text-sm">
                    A new entry pointing back at this one, which is left
                    exactly as it stands. Its number is yours to give &mdash;
                    nothing here allocates one &mdash; and it starts its own
                    clock from its own first handoff.
                  </p>
                </CardContent>
              </Card>
            )}
        </section>
      )}

      {/*
        The handoffs are the history and there is no state beside them. Whose
        move it is now is the last of these rows, which is what makes a
        turnaround dispute settleable by the record rather than by memory.
      */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Ball-in-court</h2>
          <span className="text-muted-foreground text-sm">
            {entry.handoffs.length}{' '}
            {entry.handoffs.length === 1 ? 'handoff' : 'handoffs'}
          </span>
        </div>

        <ul className="divide-y rounded-lg border">
          {entry.handoffs.map((handoff) => (
            <li
              key={handoff.id}
              className="flex flex-wrap items-center gap-3 px-4 py-3"
            >
              <span className="text-muted-foreground font-mono text-sm">
                {day(handoff.heldSince)} {clock(handoff.heldSince)}
              </span>
              <span className="font-medium">{handoff.party}</span>
              {handoff.inOurCourt && <Badge variant="destructive">Ours</Badge>}
            </li>
          ))}
        </ul>

        <HandoffForm
          submit={recordHandoff.bind(
            null,
            entry.id,
            entry.registerId,
            project.id,
          )}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">The issuance that responded</h2>
        {answered === undefined ? (
          <>
            <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
              Nothing issued on this job has been named as the response.
            </p>
            {submissions.length > 0 && (
              <LinkSubmissionForm
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
          </>
        ) : (
          <Link
            href={`/submissions/${answered.id}`}
            className="hover:bg-muted/50 flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 transition-colors"
          >
            <span className="font-medium">
              {phaseName.get(answered.phaseId) ?? 'Unknown phase'}
            </span>
            <span className="text-muted-foreground text-sm">
              {answered.revision} &middot; issued {day(answered.issuedAt)} to{' '}
              {answered.recipient}
            </span>
            {answered.currentlyProvisional && (
              <Badge variant="destructive">Provisional</Badge>
            )}
          </Link>
        )}
      </section>

      {/*
        The submittal package, the marked-up sketch — whatever this entry
        arrived with. Reached through the entry it was logged as, which is the
        whole of retrieval here (ADR-0019).
      */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Documents</h2>
          <span className="text-muted-foreground text-sm">
            {onTheEntry.length === 0
              ? 'nothing pointed at'
              : `${onTheEntry.length} pointed at`}
          </span>
        </div>

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
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Open items</h2>
          <span className="text-muted-foreground text-sm">
            {entry.openItems.filter((item) => item.resolvedAt === null).length}{' '}
            unresolved
          </span>
        </div>

        {entry.openItems.length === 0 ? (
          <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
            Nothing is being chased for this entry.
          </p>
        ) : (
          <ul className="space-y-3">
            {entry.openItems.map((item) => (
              <OpenItemEntry
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
            className="flex flex-wrap items-end gap-2 rounded-lg border p-3"
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
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Raise an open item on this entry</CardTitle>
        </CardHeader>
        <CardContent>
          <NewOpenItemForm
            submit={createOpenItemOnRegisterEntry.bind(
              null,
              entry.id,
              entry.registerId,
              project.id,
            )}
            submitLabel="Raise it"
          />
          <p className="text-muted-foreground mt-3 text-sm">
            It stays on {project.projectNumber} and appears in the pending items
            view like everything else &mdash; being chased for a register entry
            is not somewhere else to look.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
