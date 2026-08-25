import Link from 'next/link';
import { listProjects, type Project } from './api';
import { NewProjectForm } from './new-project-form';

/** Read on every request: this screen is the engineer's live-project count. */
export const dynamic = 'force-dynamic';

function ProjectList({ projects }: { projects: Project[] }) {
  return (
    <ul>
      {projects.map((project) => (
        <li key={project.id}>
          <Link href={`/projects/${project.id}`}>{project.projectNumber}</Link>{' '}
          {project.name}
        </li>
      ))}
    </ul>
  );
}

export default async function Home() {
  const [live, archived] = await Promise.all([
    listProjects(),
    listProjects(true),
  ]);

  return (
    <main>
      <h1>Projects</h1>

      <p>
        <Link href="/pending">Pending items across every project &rarr;</Link>
      </p>

      {live.length === 0 ? (
        <p>No live projects.</p>
      ) : (
        <ProjectList projects={live} />
      )}

      <h2>Add a project</h2>
      <NewProjectForm />

      {archived.length > 0 && (
        <>
          <h2>Archived</h2>
          <ProjectList projects={archived} />
        </>
      )}
    </main>
  );
}
