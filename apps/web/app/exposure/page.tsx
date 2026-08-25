import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { getProject, listExposure } from '../api';
import { day } from '../open-item';

/** The point of this screen is what is carrying an unconfirmed input now. */
export const dynamic = 'force-dynamic';

/**
 * Exposure: the sets that went out and are still standing on something
 * unresolved. One of two counts, deliberately not combined with the other into
 * a score — "3 provisional submissions, 2 items past clock" says what to do
 * and "72% health" does not (ADR-0016).
 *
 * The number on the screen that sent you here is the length of this list, so
 * this page is exactly what that number counted.
 */
export default async function Exposure({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string }>;
}) {
  const { projectId } = await searchParams;

  // The job is looked up first rather than alongside. `listExposure` throws on
  // the API's 404, so fetching both together would turn an unknown id into a
  // 500 and lose the distinction the API is careful to draw between nothing
  // to act on and no such job.
  const project =
    projectId === undefined ? undefined : await getProject(projectId);
  if (projectId !== undefined && project === undefined) {
    notFound();
  }

  const carrying = await listExposure(projectId);

  return (
    <div className="space-y-6">
      <div>
        {project !== undefined && (
          <Link
            href={`/projects/${project.id}`}
            className="text-muted-foreground hover:text-foreground text-sm transition-colors"
          >
            &larr; {project.projectNumber} {project.name}
          </Link>
        )}
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Exposure</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {carrying.length === 0
            ? 'Nothing issued is standing on an unresolved open item.'
            : `${carrying.length} issued ${carrying.length === 1 ? 'submission is' : 'submissions are'} standing on an unresolved open item${
                project === undefined ? ' across every live project' : ''
              }`}
        </p>
      </div>

      {carrying.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {carrying.map((issued) => (
            <li key={issued.id}>
              <Link
                href={`/submissions/${issued.id}`}
                className="hover:bg-muted/50 flex flex-wrap items-center gap-3 px-4 py-3 transition-colors"
              >
                {project === undefined && (
                  <Badge variant="secondary" className="font-mono">
                    {issued.project.projectNumber}
                  </Badge>
                )}
                <Badge variant="outline">{issued.phase.name}</Badge>
                <span className="font-medium">{issued.revision}</span>
                <span className="text-muted-foreground text-sm">
                  issued {day(issued.issuedAt)} &middot; {issued.recipient} (
                  {issued.recipientRole})
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="text-muted-foreground text-sm">
        A count of records to act on, never a share of anything. Resolving what
        a set rests on takes it off this list and leaves standing the fact that
        it went out on unconfirmed inputs.
      </p>
    </div>
  );
}
