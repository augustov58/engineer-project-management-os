import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { selectClassName } from '../native-select';
import { listPendingItems } from '../api';
import { ScopeToggle, isMine, scopeHref, scopeOf } from '../scope';
import { day } from '../wall-clock';

/** The point of this screen is what is unresolved right now. */
export const dynamic = 'force-dynamic';

/**
 * A native select, not the Radix one: this is a GET form, so the control has
 * to serialise into the query string the way the browser does it by default.
 */
export default async function PendingItems({
  searchParams,
}: {
  searchParams: Promise<{ waitingOn?: string; sort?: string; scope?: string }>;
}) {
  const { waitingOn = '', sort, scope: asked } = await searchParams;
  const order = sort === 'newest' ? 'newest' : 'oldest';
  // *Mine* by default (issue #112, ADR-0055 part 5), which is what the
  // **owner** stopping being free text bought: "the items sitting with me" is
  // a question no string column could answer.
  const scope = scopeOf(asked);
  const items = await listPendingItems({
    waitingOn,
    sort: order,
    mine: isMine(scope),
  });
  // The toggle keeps the filter and the sort order, so widening does not
  // silently drop what the engineer had narrowed to.
  const here = (next: 'mine' | 'ours') =>
    scopeHref('/pending', next, { sort: order, waitingOn });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Pending items</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {items.length === 0
            ? isMine(scope)
              ? 'Nothing unresolved is sitting with me.'
              : 'Nothing unresolved.'
            : `${items.length} unresolved${
                isMine(scope) ? ' and sitting with me' : ''
              } across every project`}
        </p>
        <div className="mt-3">
          <ScopeToggle scope={scope} href={here} />
        </div>
      </div>

      <form
        method="get"
        className="bg-muted/30 flex flex-wrap items-end gap-3 rounded-lg border p-3"
      >
        {/*
          A GET form replaces the whole query string, so the toggle above has
          to ride along or filtering would silently widen back to *ours*.
        */}
        {scope === 'ours' && <input type="hidden" name="scope" value="ours" />}
        <div className="grid gap-1.5">
          <Label htmlFor="waitingOn">Who owes the next move</Label>
          <Input
            id="waitingOn"
            name="waitingOn"
            defaultValue={waitingOn}
            placeholder="Anyone"
            className="w-48"
          />
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
          Leave blank for anyone, or type &ldquo;Nobody&rdquo; for the items no
          one owes a move on.
        </p>
      </form>

      {items.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">Open since</TableHead>
                <TableHead className="w-24">Project</TableHead>
                <TableHead>Unresolved</TableHead>
                <TableHead>Blocks</TableHead>
                <TableHead className="w-36">Next move</TableHead>
                <TableHead className="w-36">Sits with</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="text-muted-foreground align-top tabular-nums">
                    {/*
                      Each row in its own job's zone (ADR-0054). An item whose
                      subject resolves to no project has no building and so no
                      zone; the job cell already says so with an em-dash, and
                      the frame is named here rather than guessed at.
                    */}
                    {day(item.waitingSince, item.project?.timezone ?? 'UTC')}
                  </TableCell>
                  <TableCell className="align-top">
                    {item.project === null ? (
                      <span className="text-muted-foreground">&mdash;</span>
                    ) : (
                      <Link
                        href={`/projects/${item.project.id}`}
                        className="font-mono text-sm underline-offset-4 hover:underline"
                      >
                        {item.project.projectNumber}
                      </Link>
                    )}
                  </TableCell>
                  <TableCell className="align-top font-medium">
                    {item.unresolved}
                  </TableCell>
                  <TableCell className="text-muted-foreground align-top">
                    {item.blocks}
                  </TableCell>
                  <TableCell className="align-top">
                    <Badge variant="outline">
                      {item.waitingOn ?? 'Nobody'}
                    </Badge>
                  </TableCell>
                  {/*
                    Our side of the line, where **next move** is theirs: an
                    open item sits with a user and waits on a party.
                  */}
                  <TableCell className="text-muted-foreground align-top">
                    {item.owner.name}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
