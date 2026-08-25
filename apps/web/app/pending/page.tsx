import Link from 'next/link';
import { listPendingItems } from '../api';
import { day } from '../open-item';

/** The point of this screen is what is unresolved right now. */
export const dynamic = 'force-dynamic';

export default async function PendingItems({
  searchParams,
}: {
  searchParams: Promise<{ waitingOn?: string; sort?: string }>;
}) {
  const { waitingOn = '', sort } = await searchParams;
  const order = sort === 'newest' ? 'newest' : 'oldest';
  const items = await listPendingItems({ waitingOn, sort: order });

  return (
    <main>
      <p>
        <Link href="/">&larr; Projects</Link>
      </p>

      <h1>Pending items</h1>

      <form method="get">
        <label>
          Who owes the next move{' '}
          <input name="waitingOn" defaultValue={waitingOn} size={20} />
        </label>{' '}
        <small>blank for anyone, or &ldquo;Nobody&rdquo;</small>{' '}
        <label>
          Age{' '}
          <select name="sort" defaultValue={order}>
            <option value="oldest">Oldest first</option>
            <option value="newest">Newest first</option>
          </select>
        </label>{' '}
        <button type="submit">Filter</button>
      </form>

      {items.length === 0 ? (
        <p>Nothing unresolved.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th align="left">Since</th>
              <th align="left">Project</th>
              <th align="left">Unresolved</th>
              <th align="left">Blocks</th>
              <th align="left">Next move</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td valign="top">{day(item.waitingSince)}</td>
                <td valign="top">
                  {item.project === null ? (
                    '—'
                  ) : (
                    <Link href={`/projects/${item.project.id}`}>
                      {item.project.projectNumber}
                    </Link>
                  )}
                </td>
                <td valign="top">{item.unresolved}</td>
                <td valign="top">{item.blocks}</td>
                <td valign="top">{item.waitingOn ?? 'Nobody'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
