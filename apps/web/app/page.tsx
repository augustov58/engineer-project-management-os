const apiUrl = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://127.0.0.1:3001';

interface SkeletonRecord {
  id: string;
  label: string;
  createdAt: string;
}

interface Health {
  queue: { name: string; waiting: number; active: number };
  now: string;
}

const createCommand =
  `curl -X POST ${apiUrl}/skeleton-records ` +
  `-H 'content-type: application/json' -d '{"label":"hello"}'`;

/** Read on every request: the point is to prove the path, not to cache it. */
export const dynamic = 'force-dynamic';

export default async function Home() {
  const [records, health] = await Promise.all([
    fetch(`${apiUrl}/skeleton-records`, { cache: 'no-store' }).then(
      (response) => response.json() as Promise<SkeletonRecord[]>,
    ),
    fetch(`${apiUrl}/health`, { cache: 'no-store' }).then(
      (response) => response.json() as Promise<Health>,
    ),
  ]);

  return (
    <main>
      <h1>Engineer Project Management OS</h1>
      <p>
        Walking skeleton. Everything below travelled browser &rarr; API &rarr;
        PostgreSQL and back.
      </p>

      <h2>Skeleton records</h2>
      {records.length === 0 ? (
        <p>
          None yet. Create one:{' '}
          <code>{createCommand}</code>
        </p>
      ) : (
        <ul>
          {records.map((record) => (
            <li key={record.id}>
              {record.label} <small>({record.createdAt})</small>
            </li>
          ))}
        </ul>
      )}

      <h2>API health</h2>
      <p>
        This section rendered at all, so the API answered and PostgreSQL and
        Redis were both reachable.
      </p>
      <dl>
        <dt>Queue</dt>
        <dd>
          {health.queue.name} &mdash; {health.queue.waiting} waiting,{' '}
          {health.queue.active} active
        </dd>
        <dt>Time source</dt>
        <dd>{health.now}</dd>
      </dl>
    </main>
  );
}
