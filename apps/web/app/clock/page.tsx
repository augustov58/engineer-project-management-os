import { CalendarCheck } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { inCourtDays } from '../ball-in-court';
import { getProject, listClock, REGISTER_NAMES } from '../api';
import { EmptyState } from '../empty-state';
import { PageHeader } from '../page-header';
import { ScopeToggle, isMine, scopeHref, scopeOf } from '../scope';

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
  searchParams: Promise<{ projectId?: string; scope?: string }>;
}) {
  const { projectId, scope: asked } = await searchParams;
  // *Mine* by default, as the count that linked here is (issue #112): read
  // off the **current** handoff, so an entry handed to a colleague this
  // morning is sitting in their court and not in mine.
  const scope = scopeOf(asked);

  // The job is looked up first rather than alongside. `listClock` throws on
  // the API's 404, so fetching both together would turn an unknown id into a
  // 500 and lose the distinction the API is careful to draw between nothing
  // to act on and no such job.
  const project =
    projectId === undefined ? undefined : await getProject(projectId);
  if (projectId !== undefined && project === undefined) {
    notFound();
  }

  const onTheClock = await listClock(projectId, isMine(scope));
  const here = (next: 'mine' | 'ours') =>
    scopeHref('/clock', next, { projectId });

  return (
    <div className="space-y-6">
      <PageHeader
        back={
          project === undefined
            ? undefined
            : {
                href: `/projects/${project.id}`,
                label: `${project.projectNumber} ${project.name}`,
              }
        }
        title="Clock"
        description={
          onTheClock.length === 0
            ? undefined
            : `${onTheClock.length} ${
                onTheClock.length === 1
                  ? `entry is${isMine(scope) ? ' in my court and' : ''} past its clock`
                  : `entries are${isMine(scope) ? ' in my court and' : ''} past their clock`
              }${project === undefined ? ' across every live project' : ''}`
        }
        aside={<ScopeToggle scope={scope} href={here} />}
      />

      {onTheClock.length === 0 ? (
        <EmptyState icon={<CalendarCheck aria-hidden />}>
          Nothing is sitting in {isMine(scope) ? 'my' : 'our'} court past its
          turnaround.
        </EmptyState>
      ) : (
        <div className="bg-card overflow-hidden rounded-lg border shadow-xs">
          <Table>
            <TableHeader>
              <TableRow>
                {project === undefined && (
                  <TableHead className="hidden w-24 sm:table-cell">Project</TableHead>
                )}
                <TableHead className="hidden w-24 sm:table-cell">Number</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead className="hidden md:table-cell">Register</TableHead>
                <TableHead className="w-36 text-right">In our court</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {onTheClock.map((entry) => {
                const held = inCourtDays(entry.inCourtMs);
                return (
                  <TableRow key={entry.id}>
                    {project === undefined && (
                      <TableCell className="hidden sm:table-cell">
                        <Badge variant="secondary" className="font-mono">
                          {entry.project.projectNumber}
                        </Badge>
                      </TableCell>
                    )}
                    <TableCell className="hidden font-mono text-xs sm:table-cell">
                      {entry.number}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <Link
                        href={`/register-entries/${entry.id}`}
                        className="hover:text-primary font-medium transition-colors"
                      >
                        {entry.subject}
                      </Link>
                      {/*
                        On a phone the job and the number ride here, so the
                        figure this row is on the list for stays on screen.
                      */}
                      <span className="text-muted-foreground block text-xs">
                        <span className="font-mono sm:hidden">
                          {project === undefined &&
                            `${entry.project.projectNumber} · `}
                          {entry.number} &middot;{' '}
                        </span>
                        from {entry.fromParty}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden md:table-cell">
                      {REGISTER_NAMES[entry.kind]}
                    </TableCell>
                    {/*
                      Both numbers, not the overrun: the target is the reason
                      this is on the list and hiding it would leave the figure
                      unexplained.
                    */}
                    <TableCell className="text-right align-top sm:align-middle">
                      <Badge variant="destructive" className="tabular-nums">
                        {held} / {entry.turnaroundDays} days &middot; over
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        Longest in our court first. Time spent waiting on somebody else is not
        counted &mdash; the clock runs only while the ball is ours, summed from
        the handoff history. Recording a disposition hands the ball back and
        takes an entry off this list.
      </p>
    </div>
  );
}
