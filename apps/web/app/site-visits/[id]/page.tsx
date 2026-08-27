import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  completeFloor,
  endSiteVisit,
  recordObservation,
  startFloor,
} from '../../actions';
import { getSiteVisit } from '../../api';
import { day } from '../../open-item';
import { ObservationForm, StartFloorForm } from '../../site-visit-form';

export const dynamic = 'force-dynamic';

/** The clock time of an instant, which is what a schedule is read as. */
function clock(instant: string): string {
  return instant.slice(11, 16);
}

export default async function SiteVisitRecord({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const visit = await getSiteVisit(id);
  if (visit === undefined) {
    notFound();
  }

  const projectId = visit.project.id;

  async function end() {
    'use server';
    await endSiteVisit(id, projectId);
  }

  return (
    <div className="space-y-8">
      <div>
        <Link
          href={`/projects/${projectId}`}
          className="text-muted-foreground hover:text-foreground text-sm transition-colors"
        >
          &larr; {visit.project.projectNumber} {visit.project.name}
        </Link>

        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            Site visit {visit.visitedOn}
          </h1>
          {visit.endedAt === null && <Badge variant="secondary">Under way</Badge>}
        </div>

        <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-4 text-sm">
          <span>
            {clock(visit.startedAt)}
            {visit.endedAt === null ? '' : ` – ${clock(visit.endedAt)}`}
          </span>
          {visit.endedAt === null && (
            <form action={end}>
              <Button type="submit" variant="ghost" size="sm">
                End the visit
              </Button>
            </form>
          )}
        </div>
      </div>

      {/*
        The per-floor schedule. Its job is to be the window every photograph
        taken between the two stamps is attributed to (issue #11), which is why
        it reads as times rather than as a list of places.
      */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Floors</h2>
          <span className="text-muted-foreground text-sm">
            {visit.floors.length === 0
              ? 'none started'
              : `${visit.floors.length} walked`}
          </span>
        </div>

        {visit.floors.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {visit.floors.map((floor) => (
              <li
                key={floor.id}
                className="flex flex-wrap items-center gap-3 px-4 py-3"
              >
                <Badge variant="outline" className="font-mono">
                  Floor {floor.floor}
                </Badge>
                <span className="text-muted-foreground text-sm tabular-nums">
                  {clock(floor.startedAt)}
                  {floor.completedAt === null
                    ? ''
                    : ` – ${clock(floor.completedAt)}`}
                </span>
                {floor.completedAt === null && (
                  <form
                    action={completeFloor.bind(null, floor.id, id, projectId)}
                    className="ml-auto"
                  >
                    <Button type="submit" variant="ghost" size="sm">
                      Complete
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}

        <StartFloorForm submit={startFloor.bind(null, id, projectId)} />
      </section>

      {/*
        The non-issues table is the majority case, so this is the plain list it
        is, and nothing on this screen promotes one to a finding.
      */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Observations</h2>
          <span className="text-muted-foreground text-sm">
            {visit.observations.length} recorded
          </span>
        </div>

        {visit.observations.length === 0 ? (
          <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
            Nothing observed yet.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {visit.observations.map((observation) => (
              <li key={observation.id} className="space-y-1 px-4 py-3">
                <div className="text-muted-foreground flex flex-wrap items-baseline gap-3 text-sm">
                  {/*
                    The composed grammar, exactly as the field says it. Rendered
                    by the API from the components, so this screen cannot spell
                    it a second way.
                  */}
                  <span className="text-foreground font-medium">
                    {observation.location}
                  </span>
                  <span className="tabular-nums">
                    {clock(observation.observedAt)}
                  </span>
                </div>
                <p className="text-sm whitespace-pre-wrap">{observation.note}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Record an observation</CardTitle>
        </CardHeader>
        <CardContent>
          <ObservationForm
            submit={recordObservation.bind(null, id, projectId)}
          />
        </CardContent>
      </Card>

      <p className="text-muted-foreground text-sm">
        Visit recorded {day(visit.createdAt)}.
      </p>
    </div>
  );
}
