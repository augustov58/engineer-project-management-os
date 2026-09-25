import { ShieldCheck } from 'lucide-react';
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
import { getProject, listExposure } from '../api';
import { EmptyState } from '../empty-state';
import { PageHeader } from '../page-header';
import { revisionLabel } from '../revision';
import { ScopeToggle, isMine, scopeHref, scopeOf } from '../scope';
import { day } from '../wall-clock';

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
  searchParams: Promise<{ projectId?: string; scope?: string }>;
}) {
  const { projectId, scope: asked } = await searchParams;
  // *Mine* by default, as the count that linked here is (issue #112). A set
  // is mine when what it is standing on is mine.
  const scope = scopeOf(asked);

  // The job is looked up first rather than alongside. `listExposure` throws on
  // the API's 404, so fetching both together would turn an unknown id into a
  // 500 and lose the distinction the API is careful to draw between nothing
  // to act on and no such job.
  const project =
    projectId === undefined ? undefined : await getProject(projectId);
  if (projectId !== undefined && project === undefined) {
    notFound();
  }

  const carrying = await listExposure(projectId, isMine(scope));
  const here = (next: 'mine' | 'ours') =>
    scopeHref('/exposure', next, { projectId });

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
        title="Exposure"
        description={
          carrying.length === 0
            ? undefined
            : `${carrying.length} issued ${carrying.length === 1 ? 'submission is' : 'submissions are'} standing on an unresolved open item${
                isMine(scope) ? ' of mine' : ''
              }${project === undefined ? ' across every live project' : ''}`
        }
        aside={<ScopeToggle scope={scope} href={here} />}
      />

      {carrying.length === 0 ? (
        <EmptyState icon={<ShieldCheck aria-hidden />}>
          Nothing issued is standing on an unresolved open item
          {isMine(scope) ? ' of mine' : ''}.
        </EmptyState>
      ) : (
        <div className="bg-card overflow-hidden rounded-lg border shadow-xs">
          <Table>
            <TableHeader>
              <TableRow>
                {project === undefined && (
                  <TableHead className="hidden w-24 sm:table-cell">Project</TableHead>
                )}
                <TableHead>Submission</TableHead>
                <TableHead className="hidden sm:table-cell">Issued to</TableHead>
                <TableHead className="hidden w-28 sm:table-cell">Issued</TableHead>
                <TableHead className="w-28 text-right">State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {carrying.map((issued) => (
                <TableRow key={issued.id}>
                  {project === undefined && (
                    <TableCell className="hidden sm:table-cell">
                      <Badge variant="secondary" className="font-mono">
                        {issued.project.projectNumber}
                      </Badge>
                    </TableCell>
                  )}
                  <TableCell className="whitespace-normal">
                    <Link
                      href={`/submissions/${issued.id}`}
                      className="hover:text-primary font-medium transition-colors"
                    >
                      {issued.phase.name} &middot; {revisionLabel(issued.revision)}
                    </Link>
                    {/* On a phone the job, recipient and day ride here. */}
                    <span className="text-muted-foreground block text-xs sm:hidden">
                      {project === undefined && (
                        <span className="font-mono">
                          {issued.project.projectNumber} &middot;{' '}
                        </span>
                      )}
                      {issued.recipient} &middot;{' '}
                      {day(issued.issuedAt, issued.project.timezone)}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden whitespace-normal sm:table-cell">
                    {issued.recipient} ({issued.recipientRole})
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden tabular-nums sm:table-cell">
                    {day(issued.issuedAt, issued.project.timezone)}
                  </TableCell>
                  {/*
                    Every row here is currently provisional — that is what puts
                    it on this list — so the badge says it in the legend's red
                    and in words, never in colour alone.
                  */}
                  <TableCell className="text-right">
                    <Badge variant="destructive">Provisional</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        A count of records to act on, never a share of anything. Resolving what
        a set rests on takes it off this list and leaves standing the fact that
        it went out on unconfirmed inputs.
      </p>
    </div>
  );
}
