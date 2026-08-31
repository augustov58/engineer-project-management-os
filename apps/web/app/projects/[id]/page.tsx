import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  archiveProject,
  createOpenItem,
  createSiteVisit,
  createSubmission,
} from '../../actions';
import {
  getProject,
  listExposure,
  listIssues,
  listOpenItems,
  listPhases,
  listRegisters,
  listSiteVisits,
  listSubmissions,
  REGISTER_NAMES,
} from '../../api';
import { NewOpenItemForm } from '../../new-open-item-form';
import { NewPhaseForm } from '../../new-phase-form';
import { SiteVisitForm } from '../../site-visit-form';
import { SubmissionForm } from '../../submission-form';
import { clock, day, OpenItemEntry } from '../../open-item';
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

  const [
    unresolved,
    resolved,
    phases,
    submissions,
    exposure,
    siteVisits,
    issues,
    registers,
  ] = await Promise.all([
    listOpenItems(id),
    listOpenItems(id, true),
    listPhases(id),
    listSubmissions(id),
    // The same call the count links to, so the number here and the rows it
    // lands on are one query rather than two expressions that agree today.
    listExposure(id),
    listSiteVisits(id),
    listIssues(id),
    // Always two, written with the job: there is no state in which one is
    // missing and none in which a third appears (issue #14).
    listRegisters(id),
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

        {/*
          This project's exposure. The number is the length of the list it
          links to, so clicking it lands on exactly what it counted.
        */}
        {exposure.length > 0 && (
          <Link
            href={`/exposure?projectId=${id}`}
            className="text-muted-foreground hover:text-foreground hover:bg-muted/50 flex items-baseline gap-2 rounded-lg border border-dashed px-4 py-2 text-sm transition-colors"
          >
            <span className="text-foreground font-medium tabular-nums">
              {exposure.length}
            </span>
            issued {exposure.length === 1 ? 'submission is' : 'submissions are'}{' '}
            still standing on an unresolved open item
          </Link>
        )}

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
                  {/*
                    Two different facts, so two marks that can both show. A
                    set that went out on unconfirmed inputs and is still
                    standing on one carries both — collapsing them would hide
                    the historical half this ticket exists to keep.
                  */}
                  {issued.issuedProvisional && (
                    <Badge variant="secondary">Issued provisional</Badge>
                  )}
                  {/*
                    A superseded set is not what is out there, so it reads as
                    superseded rather than as provisional — and the count of
                    red marks on this screen stays the exposure count beside
                    it. What it went out on is untouched and still shown.
                  */}
                  {issued.supersededById !== null ? (
                    <Badge variant="outline">Superseded</Badge>
                  ) : (
                    issued.currentlyProvisional && (
                      <Badge variant="destructive">Provisional</Badge>
                    )
                  )}
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
            <SubmissionForm
              submit={createSubmission.bind(null, id)}
              phases={phases}
              phaseId={project.currentPhaseId}
              // A first issuance carries nothing forward; every unresolved
              // item on the job is offered and none starts ticked.
              offered={unresolved.map((item) => ({ item, carried: false }))}
              submitLabel="Record the submission"
            />
          )}
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Site visits</h2>
          <span className="text-muted-foreground text-sm">
            {siteVisits.length === 0
              ? 'no walks yet'
              : `${siteVisits.length} recorded`}
          </span>
        </div>

        {siteVisits.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {siteVisits.map((visit) => (
              <li key={visit.id}>
                <Link
                  href={`/site-visits/${visit.id}`}
                  className="hover:bg-muted/50 flex flex-wrap items-center gap-3 px-4 py-3 transition-colors"
                >
                  <span className="font-medium tabular-nums">
                    {visit.visitedOn}
                  </span>
                  <span className="text-muted-foreground text-sm tabular-nums">
                    {clock(visit.startedAt)}
                    {visit.endedAt === null ? '' : ` – ${clock(visit.endedAt)}`}
                  </span>
                  {visit.endedAt === null && (
                    <Badge variant="secondary">Under way</Badge>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Record a site visit</CardTitle>
        </CardHeader>
        <CardContent>
          <SiteVisitForm submit={createSiteVisit.bind(null, id)} />
        </CardContent>
      </Card>

      {/*
        The register of what has been found on this job. Closed issues stay in
        it: the lifecycle is the point of the record, and a list that hid what
        had closed would be the write-up with no follow-up all over again.

        There is no form here. A finding is raised from the observation it was
        seen in, on the walk that produced it, and never typed in from nothing.
      */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Issues</h2>
          <span className="text-muted-foreground text-sm">
            {issues.length === 0
              ? 'nothing found yet'
              : `${issues.filter((issue) => issue.closedAt === null).length} open of ${issues.length}`}
          </span>
        </div>

        {issues.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {issues.map((issue) => (
              <li key={issue.id}>
                <Link
                  href={`/projects/${id}/issues/${issue.number}`}
                  className="hover:bg-muted/50 flex flex-wrap items-center gap-3 px-4 py-3 transition-colors"
                >
                  {/* The identifier, which is what a report prints. */}
                  <Badge variant="outline" className="font-mono">
                    {issue.number}
                  </Badge>
                  <span className="font-medium">{issue.category}</span>
                  <span className="text-muted-foreground text-sm">
                    {/* The latest sighting: where it was last seen, and when. */}
                    {issue.observations.at(-1)?.location} &middot; last seen{' '}
                    {issue.observations.at(-1)?.siteVisit.visitedOn}
                  </span>
                  {issue.closedAt === null ? (
                    <Badge variant="destructive">Open</Badge>
                  ) : (
                    <Badge variant="secondary">
                      Closed {day(issue.closedAt)}
                    </Badge>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/*
        The two correspondence logs. There is no form here and no button that
        makes one: both exist from the moment the job does, because which
        correspondence types there are is a fact about the product rather than
        a choice about a job.
      */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Registers</h2>

        <ul className="divide-y rounded-lg border">
          {registers.map((register) => (
            <li key={register.id}>
              <Link
                href={`/registers/${register.id}`}
                className="hover:bg-muted/50 flex flex-wrap items-center gap-3 px-4 py-3 transition-colors"
              >
                <span className="font-medium">
                  {REGISTER_NAMES[register.kind]}
                </span>
                <span className="text-muted-foreground text-sm">
                  {register.entries.length === 0
                    ? 'nothing logged yet'
                    : `${register.entries.length} logged`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

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
