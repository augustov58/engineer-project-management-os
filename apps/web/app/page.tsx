import { Download, FolderOpen, SearchCheck, Timer, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { listClock, listExposure, listProjects, type Project } from './api';
import { Disclosure } from './disclosure';
import { EmptyState } from './empty-state';
import { NewProjectForm } from './new-project-form';
import { PageHeader } from './page-header';
import { ScopeToggle, isMine, scopeHref, scopeOf, type Scope } from './scope';
import { SectionHead } from './section-head';
import { StatTile } from './stat-tile';

/**
 * Read on every request. Both counts are computed queries over the records
 * they summarise, so the screen is right the moment an open item resolves or a
 * disposition lands — there is nothing here to refresh (story 48).
 */
export const dynamic = 'force-dynamic';

function ProjectList({
  projects,
  archived = false,
}: {
  projects: Project[];
  archived?: boolean;
}) {
  return (
    <ul className="bg-card divide-y rounded-lg border">
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

/**
 * How many rows of one list are on each job, keyed by the job's id (ADR-0069
 * D4, issue #173). Counted here from the list the tile above already read, so
 * a job's figure is that list narrowed to the job and the column adds no read.
 */
function perJob(rows: { project: { id: string } }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.project.id, (counts.get(row.project.id) ?? 0) + 1);
  }
  return counts;
}

/**
 * One job's share of one of the two lists: a link to that list narrowed to
 * the job at the same scope, or a dash. Named for a screen reader by the list
 * and the job, and **never** by the tiles' own words, so the tile stays the one
 * link that says what the whole list counts.
 */
function JobCount({
  count,
  list,
  project,
  scope,
}: {
  count: number;
  list: 'Exposure' | 'Clock';
  project: Project;
  scope: Scope;
}) {
  if (count === 0) {
    return (
      <span className="text-muted-foreground">
        <span aria-hidden>&mdash;</span>
        <span className="sr-only">none</span>
      </span>
    );
  }
  return (
    <Link
      href={scopeHref(`/${list.toLowerCase()}`, scope, { projectId: project.id })}
      aria-label={`${list} on ${project.projectNumber}: ${count}`}
    >
      <Badge variant="destructive" className="tabular-nums">
        {count}
      </Badge>
    </Link>
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}) {
  // *Mine* unless the engineer asked to widen (issue #112, ADR-0055 part 5).
  // "Nothing sitting in **my** court past its clock" is the outcome test, and
  // "my" is a user now rather than the only person there was.
  const scope = scopeOf((await searchParams).scope);
  const mine = isMine(scope);
  const [live, archived, exposure, onTheClock] = await Promise.all([
    listProjects(),
    listProjects(true),
    listExposure(undefined, mine),
    listClock(undefined, mine),
  ]);
  // The two cards drill through carrying the same toggle, so a count and the
  // list it lands on cannot be answering different questions.
  const drill = (path: string) => scopeHref(path, scope);

  const exposed = perJob(exposure);
  const late = perJob(onTheClock);

  return (
    // Desk measure, which `<main>` already is — plate D-01 is the lists-and-
    // rows half of the brief's `## The spacing scale, and the measure`, so this
    // screen wraps nothing narrower.
    <div className="space-y-8">
      {/*
        The morning screen, and it is the landing view rather than a page the
        engineer has to remember to open (story 47). The daily layer leads and
        the project list follows it, because what to do this morning is read
        off the two counts and the jobs are where you go next.

        It is the one screen whose job is to be **read in ten seconds** (the
        brief's `### Desk`).
      */}
      <PageHeader
        title="This morning"
        description="Two counts across every live project, never combined into one."
        aside={<ScopeToggle scope={scope} href={(next) => scopeHref('/', next)} />}
      />

      {/*
        The two counts, side by side and never combined (ADR-0016). Each is a
        count you can act on where a percentage is not, and each links to
        exactly the records it counted, because the number is that list's
        length. Both are shown at zero: "nothing on the clock" is the answer
        the screen exists to give on a good morning, and a tile that vanished
        would read as a screen that had not loaded. Each names where it lands
        (plate D-01's `.href`, bar 5 spelled out).
      */}
      <div className="grid gap-4 md:grid-cols-2">
        <StatTile
          href={drill('/exposure')}
          count={exposure.length}
          icon={<TriangleAlert aria-hidden />}
          label={`issued ${exposure.length === 1 ? 'submission' : 'submissions'} currently standing on an unresolved open item${mine ? ' of mine' : ''}`}
          due="Standing on something open"
          destination="Exposure"
        />
        <StatTile
          href={drill('/clock')}
          count={onTheClock.length}
          icon={<Timer aria-hidden />}
          label={
            onTheClock.length === 1
              ? `register entry sitting in ${mine ? 'my' : 'our'} court past its turnaround`
              : `register entries sitting in ${mine ? 'my' : 'our'} court past their turnaround`
          }
          due="Past turnaround"
          destination="Clock"
        />
      </div>

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <section className="min-w-0 space-y-3">
          <SectionHead
            aside={
              <span className="tabular-nums">
                {live.length === 0 ? 'none live' : `${live.length} live`}
              </span>
            }
          >
            Projects
          </SectionHead>

          {/*
            Each job's share of the two lists (ADR-0069 D4): two columns, never
            summed, never sorted on together, and each figure a link to that list
            narrowed to the job at this scope — so a column cannot say something
            the list it lands on does not.
          */}
          {live.length === 0 ? (
            <EmptyState icon={<FolderOpen aria-hidden />}>
              No live projects. Add the first one below.
            </EmptyState>
          ) : (
            <div className="bg-card overflow-hidden rounded-lg border shadow-xs">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="hidden w-28 sm:table-cell">Project</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="hidden md:table-cell">Building time</TableHead>
                    <TableHead className="w-24 text-right">Exposure</TableHead>
                    <TableHead className="w-20 text-right">Clock</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {live.map((project) => (
                    <TableRow key={project.id}>
                      <TableCell className="hidden sm:table-cell">
                        <Badge variant="secondary" className="font-mono">
                          {project.projectNumber}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        <span className="text-muted-foreground block font-mono text-xs sm:hidden">
                          {project.projectNumber}
                        </span>
                        <Link
                          href={`/projects/${project.id}`}
                          className="hover:text-primary font-medium transition-colors"
                        >
                          {project.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden md:table-cell">
                        {project.timezone}
                      </TableCell>
                      <TableCell className="text-right">
                        <JobCount
                          count={exposed.get(project.id) ?? 0}
                          list="Exposure"
                          project={project}
                          scope={scope}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <JobCount
                          count={late.get(project.id) ?? 0}
                          list="Clock"
                          project={project}
                          scope={scope}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

        {/*
          Density rule 1, and the judgment call plate D-01's annotation names:
          the form stays on the landing screen at **0 taps to reach** and costs
          **one tap** to open. That is bar 2, and it is what returns this screen
          to being readable in ten seconds — the card was the tallest thing on it
          and it is used once a job.
        */}
        <Disclosure summary="Add a project">
          {/*
            The zones this runtime knows, read on the server: the API refuses
            a name that is not one of them, so the control cannot offer one
            (ADR-0054).
          */}
          <NewProjectForm zones={Intl.supportedValuesOf('timeZone')} />
        </Disclosure>

        {/*
          Density rule 3's own example — *Archived (2)*. A finished section is
          collapsed and carries its count in the summary; nothing on this list is
          live work, which is the whole of what makes it finished.
        */}
        {archived.length > 0 && (
          <Disclosure summary={`Archived (${archived.length})`}>
            <ProjectList projects={archived} archived />
          </Disclosure>
        )}
        </section>

        <aside className="space-y-3">
          <SectionHead>Across the jobs</SectionHead>
          {/*
            Open findings across every project (issue #64). Here because it is an
            across-every-project reading and this is the across-every-project
            screen.

            **No count.** The two tiles above are the daily layer and ADR-0016
            keeps them apart precisely so nothing can combine them into a score;
            a third figure on this screen is the shape that combination would
            arrive in. The link carries the question and the list carries the
            number, which is the same reason exposure and the clock are lists.
          */}
          <Link
            href="/issues"
            className="bg-card hover:bg-muted/40 flex items-start gap-3 rounded-lg border p-4 shadow-xs transition-colors"
          >
            <span className="bg-info/10 text-info dark:bg-info/20 inline-flex size-9 shrink-0 items-center justify-center rounded-lg">
              <SearchCheck aria-hidden className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                Findings still open on every job
              </span>
              <span className="text-muted-foreground mt-0.5 block text-xs">
                Filterable by category, sortable by age. Closed findings stay on
                the job they were found on.
              </span>
            </span>
          </Link>
          {/*
            The whole record as one file (story 113, ADR-0047). Occasional where
            everything above it is daily, so last.

            A plain anchor and never `Link`: the route answers a file, and a
            client-side navigation or a prefetch of it would fetch the entire
            record to render nothing.
          */}
          <a
            href="/export"
            className="bg-card hover:bg-muted/40 flex items-start gap-3 rounded-lg border p-4 shadow-xs transition-colors"
          >
            <span className="bg-muted text-muted-foreground inline-flex size-9 shrink-0 items-center justify-center rounded-lg">
              <Download aria-hidden className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                Download the whole record as one file
              </span>
              <span className="text-muted-foreground mt-0.5 block text-xs">
                Every project and table as JSON, named for today. There is no
                import: changing employers does not mean losing the record.
              </span>
            </span>
          </a>
        </aside>
      </div>
    </div>
  );
}
