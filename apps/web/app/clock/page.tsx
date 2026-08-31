import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { inCourtDays } from '../ball-in-court';
import { getProject, listClock, REGISTER_NAMES } from '../api';

/** The point of this screen is what is sitting in our court right now. */
export const dynamic = 'force-dynamic';

/**
 * The clock: every register entry sitting in our court past its turnaround,
 * longest first (stories 43, 74).
 *
 * One of two counts, deliberately not combined with exposure into a score —
 * "3 provisional submissions, 2 items past clock" says what to do and "72%
 * health" does not (ADR-0016).
 *
 * The number on the screen that sent you here is the length of this list, so
 * this page is exactly what that number counted.
 */
export default async function Clock({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string }>;
}) {
  const { projectId } = await searchParams;

  // The job is looked up first rather than alongside. `listClock` throws on
  // the API's 404, so fetching both together would turn an unknown id into a
  // 500 and lose the distinction the API is careful to draw between nothing
  // to act on and no such job.
  const project =
    projectId === undefined ? undefined : await getProject(projectId);
  if (projectId !== undefined && project === undefined) {
    notFound();
  }

  const onTheClock = await listClock(projectId);

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
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Clock</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {onTheClock.length === 0
            ? 'Nothing is sitting in our court past its turnaround.'
            : `${onTheClock.length} ${
                onTheClock.length === 1
                  ? 'entry is past its clock'
                  : 'entries are past their clock'
              }${project === undefined ? ' across every live project' : ''}`}
        </p>
      </div>

      {onTheClock.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {onTheClock.map((entry) => {
            const held = inCourtDays(entry.inCourtMs);
            return (
              <li key={entry.id}>
                <Link
                  href={`/register-entries/${entry.id}`}
                  className="hover:bg-muted/50 flex flex-wrap items-center gap-3 px-4 py-3 transition-colors"
                >
                  {project === undefined && (
                    <Badge variant="secondary" className="font-mono">
                      {entry.project.projectNumber}
                    </Badge>
                  )}
                  <Badge variant="outline" className="font-mono">
                    {entry.number}
                  </Badge>
                  <span className="font-medium">{entry.subject}</span>
                  {/*
                    Both numbers, not the overrun: the target is the reason
                    this is on the list and hiding it would leave the figure
                    unexplained.
                  */}
                  <Badge variant="destructive" className="tabular-nums">
                    {held} / {entry.turnaroundDays} days &middot; over
                  </Badge>
                  <span className="text-muted-foreground text-sm">
                    {REGISTER_NAMES[entry.kind]} &middot; from {entry.fromParty}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-muted-foreground text-sm">
        Longest in our court first. Time spent waiting on somebody else is not
        counted &mdash; the clock runs only while the ball is ours, summed from
        the handoff history. Recording a disposition hands the ball back and
        takes an entry off this list.
      </p>
    </div>
  );
}
