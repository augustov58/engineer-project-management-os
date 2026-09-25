import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { listClock, listExposure, listProjects, type Project } from './api';
import { Disclosure } from './disclosure';
import { NewProjectForm } from './new-project-form';
import { ScopeToggle, isMine, scopeHref, scopeOf } from './scope';
import { SectionHead } from './section-head';

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

  return (
    // Desk measure, which `<main>` already is — plate D-01 is the lists-and-
    // rows half of the brief's `## The spacing scale, and the measure`, so this
    // screen wraps nothing narrower. `space-y-6` is *between sections*.
    <div className="space-y-6">
      {/*
        The morning screen, and it is the landing view rather than a page the
        engineer has to remember to open (story 47). The daily layer leads and
        the project list follows it, because what to do this morning is read
        off the two counts and the jobs are where you go next.

        It is the one screen whose job is to be **read in ten seconds** (the
        brief's `### Desk`), which is the whole of what issue #120 does to it:
        nothing new moved on, and the only form moved off.
      */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">This morning</h1>
        <p className="text-muted-foreground mt-1 text-xs">
          The daily layer, across every live project. Two counts, never
          combined into one.
        </p>
        <div className="mt-4">
          <ScopeToggle scope={scope} href={(next) => scopeHref('/', next)} />
        </div>
      </div>

      {/*
        The two counts, side by side and never combined (ADR-0016). Each is a
        count you can act on where a percentage is not, and each links to
        exactly the records it counted, because the number is that list's
        length. Both are shown at zero: "nothing on the clock" is the answer
        the screen exists to give on a good morning, and a card that vanished
        would read as a screen that had not loaded.
      */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          href={drill('/exposure')}
          className="hover:bg-muted/50 flex items-baseline gap-3 rounded-lg border p-4 transition-colors"
        >
          <span className="text-2xl font-semibold tabular-nums">
            {exposure.length}
          </span>
          <span className="text-muted-foreground text-sm">
            issued {exposure.length === 1 ? 'submission' : 'submissions'}{' '}
            currently standing on an unresolved open item
            {mine ? ' of mine' : ''}
          </span>
          {/*
            Where the count lands, said on the card (plate D-01's `.href`). It
            is bar 5 spelled out: the figure is the length of that list, and
            naming the destination is what makes "drills through to exactly the
            records it counted" readable rather than only true.
          */}
          <span className="text-muted-foreground ml-auto font-mono text-xs">
            {drill('/exposure')}
          </span>
        </Link>

        <Link
          href={drill('/clock')}
          className="hover:bg-muted/50 flex items-baseline gap-3 rounded-lg border p-4 transition-colors"
        >
          <span className="text-2xl font-semibold tabular-nums">
            {onTheClock.length}
          </span>
          <span className="text-muted-foreground text-sm">
            {onTheClock.length === 1
              ? `register entry sitting in ${mine ? 'my' : 'our'} court past its turnaround`
              : `register entries sitting in ${mine ? 'my' : 'our'} court past their turnaround`}
          </span>
          <span className="text-muted-foreground ml-auto font-mono text-xs">
            {drill('/clock')}
          </span>
        </Link>
      </div>

      <section className="space-y-3">
        {/*
          The figure moves into the head rather than sitting on a line of its
          own under it (the brief's `## The type scale`, and plate D-01 draws it
          there): a 12 px rule-under head with the count pushed to the end says
          what the `text-lg` head plus its own `<p>` said, in one row.
        */}
        <SectionHead
          aside={
            <span className="tabular-nums">
              {live.length === 0 ? 'none live' : `${live.length} live`}
            </span>
          }
        >
          Projects
        </SectionHead>

        {live.length > 0 && <ProjectList projects={live} />}
      </section>

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

      {/*
        Open findings across every project (issue #64). Here for the reason
        the export below is here: it is an across-every-project reading and
        this is the across-every-project screen, where the nav stays at four
        links because the product's shape leans on it.

        **No count.** The two cards above are the daily layer and ADR-0016
        keeps them apart precisely so nothing can combine them into a score;
        a third figure on this screen is the shape that combination would
        arrive in. The link carries the question and the list carries the
        number, which is the same reason exposure and the clock are lists.
      */}
      <section className="space-y-3">
        <SectionHead>Across the jobs</SectionHead>
        <p className="text-muted-foreground text-sm">
          <Link
            href="/issues"
            className="text-foreground underline underline-offset-4"
          >
            Findings still open on every job
          </Link>{' '}
          &mdash; the register of what has been found, read across the jobs
          rather than one at a time, filterable by category and sortable by
          age. Closed findings are not there: they stay on the job they were
          found on.
        </p>
      </section>

      {/*
        The whole record as one file (story 113, ADR-0047), reachable at last
        (issue #68). Here and not in the header: the export is an action across
        every project, and this is the across-every-project screen the engineer
        is already on each morning — the nav is four links and the product's
        shape leans on it staying that size. Last on the page because it is
        occasional where everything above it is daily.

        A plain anchor and never `Link`: the route answers a file, and a
        client-side navigation or a prefetch of it would fetch the entire
        record to render nothing.
      */}
      <section className="space-y-3">
        <SectionHead>The record</SectionHead>
        <p className="text-muted-foreground text-sm">
          <a href="/export" className="text-foreground underline underline-offset-4">
            Download the whole record as one file
          </a>{' '}
          &mdash; every project, live and archived, every table, as one JSON
          file named for today. The photographs, recordings and documents it
          names are served by their own paths and are not inside it. Nothing
          here changes when you take it, and there is no import: changing
          employers does not mean losing the record.
        </p>
      </section>
    </div>
  );
}
