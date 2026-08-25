import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  attachOpenItem,
  createOpenItemOnSubmission,
  detachOpenItem,
} from '../../actions';
import { getSubmission, listOpenItems } from '../../api';
import { selectClassName } from '../../native-select';
import { NewOpenItemForm } from '../../new-open-item-form';
import { day, OpenItemEntry } from '../../open-item';

export const dynamic = 'force-dynamic';

export default async function SubmissionRecord({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const submission = await getSubmission(id);
  if (submission === undefined) {
    notFound();
  }

  const projectId = submission.project.id;
  const attached = new Set(submission.openItems.map((item) => item.id));
  // Only what is still unresolved is worth offering: attaching an answered
  // item to a set going out is not the thing this control is for.
  const attachable = (await listOpenItems(projectId)).filter(
    (item) => !attached.has(item.id),
  );

  return (
    <div className="space-y-8">
      <div>
        <Link
          href={`/projects/${projectId}`}
          className="text-muted-foreground hover:text-foreground text-sm transition-colors"
        >
          &larr; {submission.project.projectNumber} {submission.project.name}
        </Link>

        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Badge variant="secondary">{submission.phase.name}</Badge>
          <h1 className="text-2xl font-semibold tracking-tight">
            {submission.revision}
          </h1>
          <span className="text-muted-foreground text-sm">
            issued {day(submission.issuedAt)}
          </span>
        </div>

        <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[9rem_1fr]">
          <dt className="text-muted-foreground">Issued to</dt>
          <dd>
            {submission.recipient}{' '}
            <span className="text-muted-foreground">
              ({submission.recipientRole})
            </span>
          </dd>
        </dl>
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">The set</h2>
        <pre className="overflow-x-auto rounded-lg border p-4 font-mono text-sm">
          {submission.sheetList}
        </pre>
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">What this rests on</h2>
          <span className="text-muted-foreground text-sm">
            {submission.openItems.filter((item) => item.resolvedAt === null)
              .length}{' '}
            still unresolved
          </span>
        </div>

        {submission.openItems.length === 0 ? (
          <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
            Nothing recorded against this submission.
          </p>
        ) : (
          <ul className="space-y-3">
            {submission.openItems.map((item) => (
              <OpenItemEntry
                key={item.id}
                item={item}
                projectId={projectId}
                detach={detachOpenItem.bind(null, id, projectId, item.id)}
              />
            ))}
          </ul>
        )}

        {attachable.length > 0 && (
          <form
            action={attachOpenItem.bind(null, id, projectId)}
            className="flex flex-wrap items-end gap-2 rounded-lg border p-3"
          >
            {/* Native, because the action reads this out of FormData. */}
            <select
              name="openItemId"
              aria-label="An open item this submission rests on"
              className={`${selectClassName} min-w-56 flex-1`}
              defaultValue=""
            >
              <option value="" disabled>
                An open item this rests on&hellip;
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
          <CardTitle>Raise an open item against this submission</CardTitle>
        </CardHeader>
        <CardContent>
          <NewOpenItemForm
            submit={createOpenItemOnSubmission.bind(null, id, projectId)}
          />
        </CardContent>
      </Card>
    </div>
  );
}
