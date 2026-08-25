import Link from 'next/link';
import { notFound } from 'next/navigation';
import { archiveProject } from '../../actions';
import { getProject } from '../../api';

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
    </main>
  );
}
