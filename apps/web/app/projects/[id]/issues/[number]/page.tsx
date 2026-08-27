import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  attachOpenItemToIssue,
  closeIssue,
  createOpenItemOnIssue,
  reopenIssue,
} from '../../../../actions';
import { getIssue, getProject, listOpenItems } from '../../../../api';
import { selectClassName } from '../../../../native-select';
import { NewOpenItemForm } from '../../../../new-open-item-form';
import { clock, day, OpenItemEntry } from '../../../../open-item';

export const dynamic = 'force-dynamic';

/**
 * One finding, addressed by the identifier that survives the report it first
 * appeared in — which is why the URL carries the number and not the row's id.
 */
export default async function IssueRecord({
  params,
}: {
  params: Promise<{ id: string; number: string }>;
}) {
  const { id, number } = await params;

  const [found, project] = await Promise.all([
    getIssue(id, Number(number)),
    getProject(id),
  ]);
  if (found === undefined || project === undefined) {
    notFound();
  }

  // Everything unresolved on the job that is not already being chased for this
  // finding. Resolved items are not offered: attaching one would say the
  // finding is blocked on a question that already has an answer.
  const onIt = new Set(found.openItems.map((item) => item.id));
  const attachable = (await listOpenItems(id)).filter(
    (item) => !onIt.has(item.id),
  );

  const closed = found.closedAt !== null;

  // Read out before the action closes over it: narrowing from `notFound()`
  // above does not reach inside a nested function.
  const issueId = found.id;

  async function reopen() {
    'use server';
    await reopenIssue(issueId, id);
  }

  return (
    <div className="space-y-8">
      <div>
        <Link
          href={`/projects/${id}`}
          className="text-muted-foreground hover:text-foreground text-sm transition-colors"
        >
          &larr; {project.projectNumber} {project.name}
        </Link>

        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            Issue {found.number}
          </h1>
          <Badge variant="outline">{found.category}</Badge>
          {closed ? (
            <Badge variant="secondary">Closed {day(found.closedAt ?? '')}</Badge>
          ) : (
            <Badge variant="destructive">Open</Badge>
          )}
        </div>

        <p className="text-muted-foreground mt-2 text-sm">
          {/*
            The identifier is the project's, not the walk's. Saying so here is
            what makes "issue 1" an answer rather than an ambiguity.
          */}
          Identifier {found.number} on {project.projectNumber}, raised{' '}
          {day(found.createdAt)}. It is the same reference in every report from
          now on.
        </p>
      </div>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Seen on</h2>
          <span className="text-muted-foreground text-sm">
            {found.observations.length === 1
              ? 'one walk'
              : `${found.observations.length} walks`}
          </span>
        </div>

        {/*
          The sightings are the history. There is no per-visit status beside
          them, because "still there on the second walk" is one of these rows.
        */}
        <ul className="divide-y rounded-lg border">
          {found.observations.map((sighting) => (
            <li key={sighting.id} className="space-y-1 px-4 py-3">
              <div className="text-muted-foreground flex flex-wrap items-baseline gap-3 text-sm">
                <Link
                  href={`/site-visits/${sighting.siteVisit.id}`}
                  className="hover:text-foreground font-medium tabular-nums transition-colors"
                >
                  {sighting.siteVisit.visitedOn}
                </Link>
                {/*
                  Rendered by the API from the four components, so this screen
                  cannot spell the grammar a second way.
                */}
                <span className="text-foreground">{sighting.location}</span>
                <span className="tabular-nums">
                  {clock(sighting.observedAt)}
                </span>
              </div>
              <p className="text-sm whitespace-pre-wrap">{sighting.observed}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Lifecycle</h2>

        {closed ? (
          <div className="space-y-3 rounded-lg border p-4">
            <p className="text-sm">
              <span className="text-muted-foreground">
                Closed {day(found.closedAt ?? '')} &mdash;{' '}
              </span>
              {found.closureNote}
            </p>
            <form action={reopen}>
              <Button type="submit" variant="outline" size="sm">
                Reopen
              </Button>
            </form>
            <p className="text-muted-foreground text-sm">
              Reopening clears the date and the note together: a closing reason
              left standing on an open finding would say it had been dealt with.
            </p>
          </div>
        ) : (
          <form
            action={closeIssue.bind(null, found.id, id)}
            className="flex flex-wrap items-center gap-2 rounded-lg border p-3"
          >
            <Input
              name="note"
              required
              placeholder="How it was closed"
              className="min-w-48 flex-1"
            />
            {/* Blank is today; filled in is a finding closed on an earlier walk. */}
            <Input
              name="closedAt"
              type="date"
              title="When it was closed"
              className="w-40"
            />
            <Button type="submit" variant="secondary">
              Close
            </Button>
          </form>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Open items</h2>
          <span className="text-muted-foreground text-sm">
            {found.openItems.filter((item) => item.resolvedAt === null).length}{' '}
            unresolved
          </span>
        </div>

        {found.openItems.length === 0 ? (
          <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
            Nothing is being chased for this finding.
          </p>
        ) : (
          <ul className="space-y-3">
            {found.openItems.map((item) => (
              <OpenItemEntry key={item.id} item={item} projectId={id} />
            ))}
          </ul>
        )}

        {attachable.length > 0 && (
          <form
            action={attachOpenItemToIssue.bind(null, found.id, id)}
            className="flex flex-wrap items-end gap-2 rounded-lg border p-3"
          >
            {/* Native, because the action reads this out of FormData. */}
            <select
              name="openItemId"
              aria-label="An open item being chased for this finding"
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
          <CardTitle>Raise an open item on this issue</CardTitle>
        </CardHeader>
        <CardContent>
          <NewOpenItemForm
            submit={createOpenItemOnIssue.bind(null, found.id, id)}
            submitLabel="Raise it"
          />
          <p className="text-muted-foreground mt-3 text-sm">
            It stays on {project.projectNumber} and appears in the pending items
            view like everything else &mdash; being chased for a finding is not
            somewhere else to look.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
