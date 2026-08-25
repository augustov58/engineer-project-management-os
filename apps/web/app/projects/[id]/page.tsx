import Link from 'next/link';
import { notFound } from 'next/navigation';
import { archiveProject } from '../../actions';
import { getProject, listOpenItems } from '../../api';
import { NewOpenItemForm } from '../../new-open-item-form';
import { OpenItemEntry } from '../../open-item';

/** Archived projects are readable here; only the list hides them. */
export const dynamic = 'force-dynamic';

export default async function ProjectRecord({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (project === undefined) {
    notFound();
  }

  const [unresolved, resolved] = await Promise.all([
    listOpenItems(id),
    listOpenItems(id, true),
  ]);

  async function archive() {
    'use server';
    await archiveProject(id);
  }

  return (
    <main>
      <p>
        <Link href="/">&larr; Projects</Link>
      </p>

      <h1>
        {project.projectNumber} {project.name}
      </h1>

      <dl>
        <dt>Created</dt>
        <dd>{project.createdAt}</dd>
        <dt>Status</dt>
        <dd>
          {project.archivedAt === null
            ? 'Live'
            : `Archived ${project.archivedAt}`}
        </dd>
      </dl>

      {project.archivedAt === null && (
        <form action={archive}>
          <button type="submit">Archive this project</button>
        </form>
      )}

      <h2>Open items</h2>
      {unresolved.length === 0 ? (
        <p>Nothing unresolved.</p>
      ) : (
        <ul>
          {unresolved.map((item) => (
            <OpenItemEntry key={item.id} item={item} projectId={id} />
          ))}
        </ul>
      )}

      <h3>Add an open item</h3>
      <NewOpenItemForm projectId={id} />

      {resolved.length > 0 && (
        <>
          <h3>Resolved</h3>
          <ul>
            {resolved.map((item) => (
              <OpenItemEntry key={item.id} item={item} projectId={id} />
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
