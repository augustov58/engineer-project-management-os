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
import { day } from '../open-item';

/** The point of this screen is what is unresolved right now. */
export const dynamic = 'force-dynamic';

/**
 * A native select, not the Radix one: this is a GET form, so the control has
 * to serialise into the query string the way the browser does it by default.
 */
export default async function PendingItems({
  searchParams,
}: {
  searchParams: Promise<{ waitingOn?: string; sort?: string }>;
}) {
  const { waitingOn = '', sort } = await searchParams;
  const order = sort === 'newest' ? 'newest' : 'oldest';
  const items = await listPendingItems({ waitingOn, sort: order });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Pending items</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {items.length === 0
            ? 'Nothing unresolved.'
            : `${items.length} unresolved across every project`}
        </p>
      </div>

      <form
        method="get"
        className="bg-muted/30 flex flex-wrap items-end gap-3 rounded-lg border p-3"
      >
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
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="text-muted-foreground align-top tabular-nums">
                    {day(item.waitingSince)}
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
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
