import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { listExposure, listProjects, type Project } from './api';
import { NewProjectForm } from './new-project-form';

/** Read on every request: this screen is the engineer's live-project count. */
export const dynamic = 'force-dynamic';

function ProjectList({
  projects,
  archived = false,
}: {
  projects: Project[];
  archived?: boolean;
}) {
  return (
    <ul className="divide-y rounded-lg border">
      {projects.map((project) => (
        <li key={project.id}>
          <Link
            href={`/projects/${project.id}`}
            className="hover:bg-muted/50 flex items-center gap-3 px-4 py-3 transition-colors"
          >
            <Badge
              variant={archived ? 'outline' : 'secondary'}
              className="font-mono"
            >
              {project.projectNumber}
            </Badge>
            <span className={archived ? 'text-muted-foreground' : undefined}>
              {project.name}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default async function Home() {
  const [live, archived, exposure] = await Promise.all([
    listProjects(),
    listProjects(true),
    listExposure(),
  ]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {live.length === 0
            ? 'No live projects.'
            : `${live.length} live${archived.length > 0 ? `, ${archived.length} archived` : ''}`}
        </p>
      </div>

      {/*
        Exposure across every live project, as a count you can act on and
        never as a share of anything (ADR-0016). It links to exactly the
        submissions it counted, because the number is that list's length.
      */}
      <Link
        href="/exposure"
        className="hover:bg-muted/50 flex items-baseline gap-3 rounded-lg border p-4 transition-colors"
      >
        <span className="text-2xl font-semibold tabular-nums">
          {exposure.length}
        </span>
        <span className="text-muted-foreground text-sm">
          issued {exposure.length === 1 ? 'submission' : 'submissions'}{' '}
          currently standing on an unresolved open item
        </span>
      </Link>

      {live.length > 0 && <ProjectList projects={live} />}

      <Card>
        <CardHeader>
          <CardTitle>Add a project</CardTitle>
        </CardHeader>
        <CardContent>
          <NewProjectForm />
        </CardContent>
      </Card>

      {archived.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-muted-foreground text-sm font-medium">Archived</h2>
          <ProjectList projects={archived} archived />
        </section>
      )}
    </div>
  );
}
