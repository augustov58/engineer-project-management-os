import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  attachOpenItemToRegisterEntry,
  createOpenItemOnRegisterEntry,
  linkSubmission,
  recordHandoff,
  recordResponse,
} from '../../actions';
import {
  getProject,
  getRegisterEntry,
  listOpenItems,
  listPhases,
  listSubmissions,
  REGISTER_NAMES,
} from '../../api';
import { NewOpenItemForm } from '../../new-open-item-form';
import {
  HandoffForm,
  LinkSubmissionForm,
  ResponseForm,
} from '../../register-forms';
import { selectClassName } from '../../native-select';
import { clock, day, OpenItemEntry } from '../../open-item';
import { BallInCourtBadge } from '../../ball-in-court';

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

  const [project, phases, submissions, unresolved] = await Promise.all([
    getProject(entry.projectId),
    listPhases(entry.projectId),
    listSubmissions(entry.projectId),
    listOpenItems(entry.projectId),
  ]);
  if (project === undefined) {
    notFound();
  }

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
        </div>
        <p className="text-muted-foreground mt-1 text-sm">
          From {entry.fromParty} to {entry.toParty} &middot; logged{' '}
          {day(entry.createdAt)}
        </p>
      </div>

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
