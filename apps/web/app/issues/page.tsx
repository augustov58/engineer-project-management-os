import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ISSUE_CATEGORIES, listOpenIssues } from '../api';
import { selectClassName } from '../native-select';
import { day } from '../wall-clock';

/** The point of this screen is what is still open right now. */
export const dynamic = 'force-dynamic';

/**
 * Open findings across every project (issue #64).
 *
 * *Which findings are still open across all six jobs* had no answer here
 * without opening one page per job — `/pending` answers exactly that question
 * for open items and nothing answered it for findings. This follows it: a
 * list, filterable, sortable by age, every row linking to the finding on the
 * job it is on.
 *
 * A **list and never a number**. There is no count of this on the morning
 * screen, where a third across-every-project figure beside exposure and the
 * clock is the shape a combined score would be computed from (ADR-0016) —
 * `/` links here and reads nothing off it.
 *
 * Retrieval is still by identity (ADR-0019) and this does not weaken it: a
 * finding is reached through the job, and this is that reading widened to
 * every job at once rather than a search over them. There is no search box
 * here, which is ADR-0019's own deferral with its own trigger.
 *
 * Both selects are native, not the Radix one: this is a GET form, so each
 * control has to serialise into the query string the way the browser does it.
 */
export default async function OpenIssues({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; sort?: string }>;
}) {
  const { category = '', sort } = await searchParams;
  const order = sort === 'newest' ? 'newest' : 'oldest';
  const issues = await listOpenIssues({ category, sort: order });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Open issues</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {issues.length === 0
            ? 'Nothing open.'
            : `${issues.length} still open across every project`}
        </p>
      </div>

      <form
        method="get"
        className="bg-muted/30 flex flex-wrap items-end gap-3 rounded-lg border p-3"
      >
        <div className="grid gap-1.5">
          <Label htmlFor="category">Category</Label>
          <select
            id="category"
            name="category"
            defaultValue={category}
            className={selectClassName}
          >
            <option value="">Any category</option>
            {ISSUE_CATEGORIES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="sort">Age</Label>
          <select
            id="sort"
            name="sort"
            defaultValue={order}
            className={selectClassName}
          >
            <option value="oldest">Oldest first</option>
            <option value="newest">Newest first</option>
          </select>
        </div>

        <Button type="submit" variant="secondary">
          Filter
        </Button>

        <p className="text-muted-foreground w-full text-sm">
          Closed findings are not here. They stay on the job they were found
          on, where the lifecycle is the point of the record.
        </p>
      </form>

      {issues.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">Raised</TableHead>
                <TableHead className="w-24">Project</TableHead>
                <TableHead className="w-16">Issue</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {issues.map((issue) => {
                // An issue owns no content, so where and when it was seen is
                // read off its sightings — the latest of them, since a
                // finding re-observed on three walks has three locations.
                const latest = issue.observations.at(-1);
                return (
                  <TableRow key={issue.id}>
                    <TableCell className="text-muted-foreground align-top tabular-nums">
                      {day(issue.createdAt, issue.project.timezone)}
                    </TableCell>
                    <TableCell className="align-top">
                      <Link
                        href={`/projects/${issue.project.id}`}
                        className="font-mono text-sm underline-offset-4 hover:underline"
                      >
                        {issue.project.projectNumber}
                      </Link>
                    </TableCell>
                    <TableCell className="align-top">
                      {/* The identifier, which is what a report prints. */}
                      <Link
                        href={`/projects/${issue.project.id}/issues/${issue.number}`}
                        className="font-mono text-sm underline-offset-4 hover:underline"
                      >
                        {issue.number}
                      </Link>
                    </TableCell>
                    <TableCell className="align-top font-medium">
                      {issue.category}
                    </TableCell>
                    <TableCell className="text-muted-foreground align-top">
                      {latest === undefined ? (
                        <span>&mdash;</span>
                      ) : (
                        <>
                          {latest.location}
                          <Badge variant="outline" className="ml-2">
                            {latest.siteVisit.visitedOn}
                          </Badge>
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
