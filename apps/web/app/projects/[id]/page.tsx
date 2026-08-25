import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { archiveProject, createOpenItem } from '../../actions';
import {
  getProject,
  listOpenItems,
  listPhases,
  listSubmissions,
} from '../../api';
import { NewOpenItemForm } from '../../new-open-item-form';
import { NewPhaseForm } from '../../new-phase-form';
import { NewSubmissionForm } from '../../new-submission-form';
import { day, OpenItemEntry } from '../../open-item';
import { PhaseList } from '../../phases';

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

  const [unresolved, resolved, phases, submissions] = await Promise.all([
    listOpenItems(id),
    listOpenItems(id, true),
    listPhases(id),
    listSubmissions(id),
  ]);

  const phaseName = new Map(phases.map((phase) => [phase.id, phase.name]));

  async function archive() {
    'use server';
    await archiveProject(id);
  }

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/"
          className="text-muted-foreground hover:text-foreground text-sm transition-colors"
        >
          &larr; Projects
        </Link>

        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Badge variant="secondary" className="font-mono text-sm">
            {project.projectNumber}
          </Badge>
          <h1 className="text-2xl font-semibold tracking-tight">
            {project.name}
          </h1>
          {project.archivedAt !== null && (
            <Badge variant="outline">Archived {day(project.archivedAt)}</Badge>
          )}
        </div>

        <div className="text-muted-foreground mt-2 flex items-center gap-4 text-sm">
          <span>Created {day(project.createdAt)}</span>
          {project.archivedAt === null && (
            <form action={archive}>
              <Button type="submit" variant="ghost" size="sm">
                Archive this project
              </Button>
            </form>
          )}
        </div>
      </div>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Open items</h2>
          <span className="text-muted-foreground text-sm">
            {unresolved.length} unresolved
          </span>
        </div>

        {unresolved.length === 0 ? (
          <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
            Nothing unresolved.
          </p>
        ) : (
          <ul className="space-y-3">
            {unresolved.map((item) => (
              <OpenItemEntry key={item.id} item={item} projectId={id} />
            ))}
          </ul>
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Add an open item</CardTitle>
        </CardHeader>
        <CardContent>
          <NewOpenItemForm submit={createOpenItem.bind(null, id)} />
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Submissions</h2>
          <span className="text-muted-foreground text-sm">
            {submissions.length === 0
              ? 'nothing issued yet'
              : `${submissions.length} issued`}
          </span>
        </div>

        {submissions.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {submissions.map((issued) => (
              <li key={issued.id}>
                <Link
                  href={`/submissions/${issued.id}`}
                  className="hover:bg-muted/50 flex flex-wrap items-center gap-3 px-4 py-3 transition-colors"
                >
                  <Badge variant="outline">
                    {phaseName.get(issued.phaseId) ?? 'Unknown phase'}
                  </Badge>
                  <span className="font-medium">{issued.revision}</span>
                  <span className="text-muted-foreground text-sm">
                    {day(issued.issuedAt)} &middot; {issued.recipient} (
                    {issued.recipientRole})
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Record a submission</CardTitle>
        </CardHeader>
        <CardContent>
          {phases.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              A submission is issued at a phase. Define one below first.
            </p>
          ) : (
            <NewSubmissionForm
              projectId={id}
              phases={phases}
              currentPhaseId={project.currentPhaseId}
              unresolved={unresolved}
            />
          )}
        </CardContent>
      </Card>

      {resolved.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-muted-foreground text-sm font-medium">
            Resolved ({resolved.length})
          </h2>
          <ul className="space-y-3">
            {resolved.map((item) => (
              <OpenItemEntry key={item.id} item={item} projectId={id} />
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-muted-foreground text-sm font-medium">Phases</h2>
          <span className="text-muted-foreground text-sm">
            free text, in the order this job runs them
          </span>
        </div>

        {phases.length > 0 && (
          <PhaseList
            phases={phases}
            projectId={id}
            currentPhaseId={project.currentPhaseId}
          />
        )}
        <NewPhaseForm projectId={id} />
      </section>
    </div>
  );
}
