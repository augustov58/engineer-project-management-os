import {
  BookOpen,
  Brain,
  Calendar,
  ChevronRight,
  CircleCheck,
  Clock,
  FileText,
  HardHat,
  History,
  Inbox,
  Info,
  ListOrdered,
  MessageSquareText,
  ScanSearch,
  ScanText,
  Send,
  Timer,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  addDocument,
  addIngestedDocument,
  archiveProject,
  askOnProject,
  confirmAssumptionRecord,
  createOpenItem,
  createSiteVisit,
  createSubmission,
} from '../../actions';
import {
  REGISTER_NAMES,
  getMemory,
  getProject,
  listClock,
  listDocuments,
  listExposure,
  listExtractions,
  listIngestedDocuments,
  listIssues,
  listMemoryProposals,
  listMemoryRuns,
  listOpenItems,
  listPhases,
  listProjectConversations,
  listRegisters,
  listSiteVisits,
  listSubmissions,
  listUsers,
} from '../../api';
import { ChatProgress } from '../../conversation';
import { ConversationPanel } from '../../conversation-panel';
import { Disclosure } from '../../disclosure';
import { DocumentForm } from '../../document-form';
import { DocumentList } from '../../documents';
import { ExtractionList } from '../../extractions';
import { IngestForm } from '../../ingest-form';
import { IngestAddress, IngestedDocumentList } from '../../ingest';
import { MemoryActivityList, MemoryForm } from '../../memory';
import { NewOpenItemForm } from '../../new-open-item-form';
import { NewPhaseForm } from '../../new-phase-form';
import { PageHeader } from '../../page-header';
import { PhaseStrip } from '../../phase-strip';
import { revisionLabel } from '../../revision';
import { SectionHead } from '../../section-head';
import { SiteVisitForm } from '../../site-visit-form';
import { SubmissionForm } from '../../submission-form';
import { OpenItemEntry } from '../../open-item';
import { scopeHref } from '../../scope';
import { clock, day } from '../../wall-clock';
import { PhaseList } from '../../phases';
import { ProcessingLocation } from '../../processing-location';
import { StatTile } from '../../stat-tile';

/** Archived projects are readable here; only the list hides them. */
export const dynamic = 'force-dynamic';

/**
 * The jumper's sections, in the order the record reads (issue #175, the plan's
 * §6.3). Plain anchors, the walk's pattern: sticky, 44 px targets, and no
 * script, so it works before hydration. *Registers* is in the rail, which sits
 * beside the record at 1 280 px and above it below that; *Resolved* is not
 * listed, being the fold directly under *Open items*.
 */
const SECTIONS = [
  { id: 'open-items', label: 'Open items' },
  { id: 'submissions', label: 'Submissions' },
  { id: 'site-visits', label: 'Site visits' },
  { id: 'issues', label: 'Issues' },
  { id: 'registers', label: 'Registers' },
  { id: 'documents', label: 'Documents' },
  { id: 'arrived', label: 'Arrived' },
  { id: 'extractions', label: 'Extractions' },
  { id: 'memory', label: 'Memory' },
  { id: 'conversation', label: 'Conversation' },
];

/** The latest of a list by an ISO instant, which sorts as text. */
function latest<T>(rows: T[], at: (row: T) => string | null): T | undefined {
  return rows.reduce<T | undefined>((found, row) => {
    const when = at(row);
    return when !== null && (found === undefined || when > (at(found) ?? ''))
      ? row
      : found;
  }, undefined);
}

/**
 * One card of the rail (ADR-0069 D3). A sheet with a small heading and not a
 * `<section>`: the record's sections are what the page's tests and its reader
 * walk in order, and the rail is facts about the job beside them.
 */
function RailCard({
  id,
  icon,
  title,
  aside,
  children,
}: {
  id?: string;
  icon: ReactNode;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div id={id} className="bg-card scroll-mt-14 rounded-lg border p-4 shadow-xs">
      <h2 className="flex items-center gap-2 text-sm font-semibold [&>svg]:size-4 [&>svg]:shrink-0">
        {icon}
        {title}
        {aside !== undefined && (
          <span className="text-muted-foreground ml-auto text-xs font-normal tabular-nums">
            {aside}
          </span>
        )}
      </h2>
      <div className="mt-3">{children}</div>
    </div>
  );
}

export default async function ProjectRecord({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /**
   * `?kept=` names the open item that resolved on the request before this one,
   * and it is the whole of density rule 4 (issue #120). Nothing is stored: it
   * is a rendering instruction that survives exactly one navigation.
   */
  searchParams: Promise<{ kept?: string }>;
}) {
  const { id } = await params;
  const { kept } = await searchParams;
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
    onTheClock,
    documents,
    memory,
    memoryRuns,
    memoryProposals,
    arrivals,
    extractions,
    users,
    conversations,
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
    // The same call the count links to, as exposure's is (issue #15).
    listClock(id),
    // What is stored against this job, reached through the job itself —
    // there is no search box here or anywhere else (ADR-0019).
    listDocuments(id),
    // The curated prose, its runs and its proposals (issue #18). The audit is
    // no longer read here: story 106 widened it past memory, so it is the
    // job's activity and has a screen of its own (issue #83, ADR-0048).
    getMemory(id),
    listMemoryRuns(id),
    listMemoryProposals(id),
    // What has arrived from outside and not yet been read (issue #19).
    listIngestedDocuments(id),
    // The extractions asked for on this job and their states (issue #20).
    listExtractions(id),
    // Everyone at the firm, so an open item can be handed on (issue #112).
    listUsers(),
    // The job's conversations, newest first (issue #121). The panel below
    // shows the latest; a job with none shows the bar and nothing above it.
    listProjectConversations(id),
  ]);

  const phaseName = new Map(phases.map((phase) => [phase.id, phase.name]));
  const [conversation] = conversations;

  /*
    Density rule 4, and it is a **rendering** rule rather than a feature: the
    item that just resolved is lifted back out of *Resolved* and shown where it
    was, with its new state and its undo beside it, for exactly the one load
    that follows the resolve. The baseline's bar 6 recorded this as *hunting* —
    one action to reopen, but the row had left *Open items* for *Resolved (1)*
    4 009 px down a 4 480 px page, five screens from where the mistake was made.

    The id comes off the query string, so a reload or a bookmark shows the plain
    filing and nothing has to be un-done. An id that names something that is not
    in fact resolved keeps nothing, which is what makes a hand-typed `?kept=`
    harmless.
  */
  const keptItem =
    kept === undefined
      ? undefined
      : resolved.find((item) => item.id === kept);
  const filed = resolved.filter((item) => item.id !== keptItem?.id);

  /*
    What each closed card says about itself (issue #175), read off what this
    page already fetched and nothing else: a summary line that needed a query
    of its own would be a second answer free to disagree with the section under
    it.
  */
  const lastIssued = latest(submissions, (one) => one.issuedAt);
  const lastVisit = latest(siteVisits, (one) => one.startedAt);
  const lastResolved = latest(filed, (one) => one.resolvedAt);
  const openIssues = issues.filter((issue) => issue.closedAt === null).length;
  const awaiting = extractions.filter((one) => one.state === 'pending').length;
  const forwarded = arrivals.filter((one) => one.source === 'EMAIL').length;
  const referenced = documents.filter((one) => one.referencedFile).length;
  // The clock list, grouped by register for the rail — the same list the tile
  // counts, so a register's figure and the clock's rows are one query (bar 5),
  // and never added to anything.
  const pastTurnaround = new Map<string, number>();
  for (const entry of onTheClock) {
    pastTurnaround.set(
      entry.registerId,
      (pastTurnaround.get(entry.registerId) ?? 0) + 1,
    );
  }

  async function archive() {
    'use server';
    await archiveProject(id);
  }

  return (
    <div className="space-y-6">
      {/*
        The head is at the **desk** measure and the sections below are at the
        record's — the project record is the one screen in the product that uses
        both (the brief's `## The spacing scale, and the measure`). What is up
        here compares across the job; what is below is a record being read.

        The title block of ADR-0069 (issue #175): the job's number as the chip a
        drawing's title block carries, the name, the building's zone and when it
        was opened, and what can be done from here.
      */}
      <PageHeader
        back={{ href: '/', label: 'This morning' }}
        title={
          <>
            <span className="bg-muted text-muted-foreground mb-1.5 block w-fit rounded-md border px-2 py-0.5 font-mono text-xs font-medium tracking-normal">
              {project.projectNumber}
            </span>
            {project.name}
          </>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="inline-flex items-center gap-1.5">
              <Clock aria-hidden className="size-4" />
              {project.timezone}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Calendar aria-hidden className="size-4" />
              Created {day(project.createdAt, project.timezone)}
            </span>
            {project.archivedAt !== null && (
              <Badge variant="outline">
                Archived {day(project.archivedAt, project.timezone)}
              </Badge>
            )}
          </span>
        }
        aside={
          <div className="flex flex-wrap items-center gap-2">
            {/*
              The activity feed, here and not under Memory: story 106 widened the
              audit from memory's mutations to all sixty-two, so it stopped being
              a memory thing the moment it stopped being about memory (issue #83).
              A link and never a count — the feed is bounded, so its length is
              not the number of anything (ADR-0048).
            */}
            <Button asChild variant="outline">
              <Link href={`/projects/${id}/activity`}>
                <History aria-hidden />
                What happened lately
              </Link>
            </Button>
            {/* The conversation is the last section; this is the way to it. */}
            <Button asChild>
              <a href="#conversation">
                <MessageSquareText aria-hidden />
                Ask about this job
              </a>
            </Button>
            {/*
              Behind a disclosure, the plan's overflow: nothing un-archives a
              job, and a one-tap button beside the two above was one mis-click
              from taking the job off every list. Native, so it needs no script;
              pushed to the end of its row so the sheet opens inside the page.
            */}
            {project.archivedAt === null && (
              <details className="relative ml-auto">
                <summary className="hover:bg-muted text-muted-foreground inline-flex h-9 cursor-pointer list-none items-center rounded-md px-3 text-sm font-medium transition-colors [&::-webkit-details-marker]:hidden">
                  More
                </summary>
                <div className="bg-card absolute right-0 z-20 mt-1 w-56 rounded-lg border p-1 shadow-md">
                  <form action={archive}>
                    <Button
                      type="submit"
                      variant="ghost"
                      className="w-full justify-start"
                    >
                      Archive this project
                    </Button>
                  </form>
                </div>
              </details>
            )}
          </div>
        }
      />

      <PhaseStrip phases={phases} currentPhaseId={project.currentPhaseId} />

      {/*
        The two count strips, lifted out of the Submissions and Registers
        sections and read at desk width beside each other, as plate D-02 draws
        them — the morning screen's `StatTile` since issue #175. They are the
        job's half of the daily layer and they are never combined (ADR-0016);
        they stay **gated on being non-empty**, where the morning screen's two
        cards render at zero, because on a project screen an empty count is
        noise and on the morning screen the count is the screen. That asymmetry
        is ADR-0038's and is intended.

        **Two tiles and not the plan's four.** An open-items tile and an issues
        tile would be ADR-0016's third and fourth figures, which the morning
        screen refused as well (#173); each count stays in its own section's
        head, where it is a fact about that section and not a score.

        Each number is read unfiltered and each link carries `scope=ours`, so a
        count and the list it lands on cannot answer different questions — the
        baseline's bar 5 failure, fixed in issue #141 and drawn here as the rule.
        The words say *our court*, which is what a route hint used to point at.
      */}
      {(exposure.length > 0 || onTheClock.length > 0) && (
        <div className="grid gap-4 sm:grid-cols-2">
          {exposure.length > 0 && (
            <StatTile
              href={scopeHref('/exposure', 'ours', { projectId: id })}
              count={exposure.length}
              icon={<TriangleAlert aria-hidden />}
              label={`issued ${exposure.length === 1 ? 'submission is' : 'submissions are'} still standing on an unresolved open item — our court`}
              due="Standing on something open"
              destination="Exposure on this job"
            />
          )}
          {onTheClock.length > 0 && (
            <StatTile
              href={scopeHref('/clock', 'ours', { projectId: id })}
              count={onTheClock.length}
              icon={<Timer aria-hidden />}
              label={
                onTheClock.length === 1
                  ? 'entry is sitting in our court past its turnaround'
                  : 'entries are sitting in our court past their turnaround'
              }
              due="Past turnaround"
              destination="Clock on this job"
            />
          )}
        </div>
      )}

      {/*
        Density rule 5 reaching the desk (issue #175): the walk's jumper, plain
        anchors, sticky, each a 44 px target, and `overflow-x-auto` rather than
        wrapping — ten do not fit across a phone and a two-row bar is not a
        44 px bar.
      */}
      <nav
        aria-label="Sections"
        className="bg-background sticky top-0 z-10 flex min-h-11 items-center gap-5 overflow-x-auto border-b text-sm"
      >
        {SECTIONS.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className="text-muted-foreground hover:text-foreground flex min-h-11 items-center whitespace-nowrap transition-colors"
          >
            {section.label}
          </a>
        ))}
      </nav>

      {/*
        ADR-0069 D3: at 1 280 px the rail sits beside the record, which keeps
        `--measure-record` as its cap, and below that it folds under the tiles.
        It comes first in the source for that reason — the phone reads it first
        — and the grid places it on the right at the desk.
      */}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start">
        <div className="grid gap-4 sm:grid-cols-2 sm:items-start xl:col-start-2 xl:row-start-1 xl:grid-cols-1">
          {/*
            The two correspondence logs. There is no form here and no button
            that makes one: both exist from the moment the job does, because
            which correspondence types there are is a fact about the product
            rather than a choice about a job.
          */}
          <RailCard id="registers" icon={<BookOpen aria-hidden />} title="Registers">
            <ul className="-mx-2">
              {registers.map((register) => {
                const over = pastTurnaround.get(register.id) ?? 0;
                return (
                  <li key={register.id}>
                    <Link
                      href={`/registers/${register.id}`}
                      className="hover:bg-muted/50 flex items-center gap-3 rounded-md px-2 py-2 transition-colors"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">
                          {REGISTER_NAMES[register.kind]}
                        </span>
                        <span className="text-muted-foreground block text-xs">
                          {register.entries.length === 0
                            ? 'nothing logged yet'
                            : `${register.entries.length} logged`}
                        </span>
                      </span>
                      {over > 0 && (
                        <Badge variant="destructive">
                          {over} past turnaround
                        </Badge>
                      )}
                      <ChevronRight
                        aria-hidden
                        className="text-muted-foreground size-4 shrink-0"
                      />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </RailCard>

          <RailCard
            id="phases"
            icon={<ListOrdered aria-hidden />}
            title="Phases"
            aside={phases.length}
          >
            <div className="space-y-3">
              {phases.length === 0 && (
                <p className="text-muted-foreground text-sm">
                  None yet. A submission is issued at a phase.
                </p>
              )}
              <Disclosure
                summary={
                  phases.length === 0
                    ? 'Add a phase'
                    : 'Rename, reorder or add a phase'
                }
              >
                <div className="space-y-3">
                  <p className="text-muted-foreground text-xs">
                    Free text, in the order this job runs them.
                  </p>
                  {phases.length > 0 && (
                    <PhaseList
                      phases={phases}
                      projectId={id}
                      currentPhaseId={project.currentPhaseId}
                    />
                  )}
                  <NewPhaseForm projectId={id} />
                </div>
              </Disclosure>
            </div>
          </RailCard>

          <RailCard icon={<Info aria-hidden />} title="Job facts">
            <dl className="grid gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground text-xs">Building time</dt>
                <dd>{project.timezone}</dd>
              </div>
              {/*
                Read only: the switch and its sign-off are one panel under
                Extractions, above the list it governs (issue #21, ADR-0044).
              */}
              <div>
                <dt className="text-muted-foreground text-xs">
                  Processing location
                </dt>
                <dd className="flex flex-wrap items-center gap-2">
                  {project.processingLocation === 'LOCAL' ? 'Local' : 'Cloud'}
                  {project.cloudSignoffReference !== null ? (
                    <Badge variant="success">
                      Signed off {project.cloudSignoffReference}
                    </Badge>
                  ) : (
                    project.processingLocation === 'CLOUD' && (
                      <span className="text-muted-foreground text-xs">
                        no written sign-off recorded
                      </span>
                    )
                  )}
                </dd>
              </div>
            </dl>
          </RailCard>
        </div>

        {/*
          The record, at `--measure-record`. Open items leads and stays open —
          it is the job's live work and the only section plate D-02 draws
          unrolled — and every other section is a disclosure carrying its count
          in the summary. That is density rules 1, 2 and 3 together, and it is
          what takes this screen from the baseline's 4 479 px, five and a half
          screens. Since issue #175 each summary also says what is in it.

          **Conversation** is the other section plate D-02 draws unrolled (issue
          #121) and it is the **last** one since issue #164, the author's call
          against the plate: second on the page, it buried the record as it
          grew. It is the same panel the walk has, which is what the brief means
          by *"one component, two contexts"* — a `<section>` and not a
          disclosure, because a chat behind a summary is a chat nobody opens.
        */}
        {/*
          The cards sit 12 px apart, as one stack (the plan's §6.3), and the
          conversation keeps the 24 px a section gets.
        */}
        <div className="max-w-[var(--measure-record)] min-w-0 space-y-3 xl:col-start-1 xl:row-start-1 [&>#conversation]:pt-3">
          <section id="open-items" className="scroll-mt-14 space-y-3">
            <SectionHead
              aside={
                <span className="tabular-nums">
                  {unresolved.length} unresolved
                </span>
              }
            >
              Open items
            </SectionHead>

            {unresolved.length === 0 && keptItem === undefined ? (
              <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
                Nothing unresolved.
              </p>
            ) : (
              <ul className="space-y-3">
                {unresolved.map((item) => (
                  <OpenItemEntry
                    timeZone={project.timezone}
                    key={item.id}
                    item={item}
                    projectId={id}
                    users={users}
                    keepInPlace
                  />
                ))}
                {keptItem !== undefined && (
                  <OpenItemEntry
                    timeZone={project.timezone}
                    key={keptItem.id}
                    item={keptItem}
                    projectId={id}
                    users={users}
                    kept
                  />
                )}
              </ul>
            )}

            {/*
              Density rule 1, and bar 1: one tap from the top of the record with
              its four required fields together, rather than 405 px down a
              five-screen page.
            */}
            <Disclosure summary="Add an open item">
              <NewOpenItemForm submit={createOpenItem.bind(null, id)} />
            </Disclosure>
          </section>

          {/*
            Density rule 3's first example, and it sits directly under the section
            it was filed out of: the row the baseline had to hunt 4 009 px for is
            now one tap below where the mistake was made.
          */}
          {filed.length > 0 && (
            <Disclosure
              summary="Resolved"
              icon={<CircleCheck aria-hidden />}
              count={filed.length}
              detail={
                lastResolved?.resolvedAt == null
                  ? undefined
                  : `latest ${day(lastResolved.resolvedAt, project.timezone)}`
              }
            >
              <ul className="space-y-3">
                {filed.map((item) => (
                  <OpenItemEntry
                    timeZone={project.timezone}
                    key={item.id}
                    item={item}
                    projectId={id}
                    users={users}
                  />
                ))}
              </ul>
            </Disclosure>
          )}

          <Disclosure
            id="submissions"
            summary="Submissions"
            icon={<Send aria-hidden />}
            count={submissions.length === 0 ? undefined : submissions.length}
            detail={
              lastIssued === undefined
                ? 'None issued yet'
                : `${phaseName.get(lastIssued.phaseId) ?? 'Unknown phase'} · ${revisionLabel(lastIssued.revision)} to ${lastIssued.recipient} · ${day(lastIssued.issuedAt, project.timezone)}`
            }
            state={
              // The latest set's own state, the line above being about it; the
              // tile counts every set that is standing on something.
              lastIssued !== undefined &&
              lastIssued.supersededById === null &&
              lastIssued.currentlyProvisional ? (
                <Badge variant="destructive">Provisional</Badge>
              ) : undefined
            }
          >
            <div className="space-y-3">
              {submissions.length > 0 && (
                <ul className="bg-card divide-y rounded-lg border">
                  {submissions.map((issued) => (
                    <li key={issued.id}>
                      <Link
                        href={`/submissions/${issued.id}`}
                        className="hover:bg-muted/50 flex flex-wrap items-center gap-3 px-3 py-2 transition-colors"
                      >
                        <Badge variant="outline">
                          {phaseName.get(issued.phaseId) ?? 'Unknown phase'}
                        </Badge>
                        <span className="font-medium">
                          {revisionLabel(issued.revision)}
                        </span>
                        <span className="text-muted-foreground text-xs">
                          {day(issued.issuedAt, project.timezone)} &middot;{' '}
                          {issued.recipient} ({issued.recipientRole})
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

              <Disclosure summary="Record a submission">
                {phases.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    A submission is issued at a phase. Define one under Phases
                    below first.
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
              </Disclosure>
            </div>
          </Disclosure>

          <Disclosure
            id="site-visits"
            summary="Site visits"
            icon={<HardHat aria-hidden />}
            count={siteVisits.length === 0 ? undefined : siteVisits.length}
            detail={
              lastVisit === undefined
                ? 'No walks yet'
                : `${lastVisit.visitedOn} · ${clock(lastVisit.startedAt, project.timezone)}${
                    lastVisit.endedAt === null
                      ? ''
                      : `–${clock(lastVisit.endedAt, project.timezone)}`
                  } · ${lastVisit.conductedBy.name}`
            }
            state={
              lastVisit !== undefined && lastVisit.endedAt === null ? (
                // `/12` in dark, the nav's answer (#171): blue ink on the
                // legend's `/20` read 4.96:1 on the dark sheet.
                <Badge variant="info" className="dark:bg-info/12">
                  Under way
                </Badge>
              ) : undefined
            }
          >
            <div className="space-y-3">
              {siteVisits.length > 0 && (
                <ul className="bg-card divide-y rounded-lg border">
                  {siteVisits.map((visit) => (
                    <li key={visit.id}>
                      <Link
                        href={`/site-visits/${visit.id}`}
                        className="hover:bg-muted/50 flex flex-wrap items-center gap-3 px-3 py-2 transition-colors"
                      >
                        <span className="font-medium tabular-nums">
                          {visit.visitedOn}
                        </span>
                        <span className="text-muted-foreground text-xs tabular-nums">
                          {clock(visit.startedAt, project.timezone)}
                          {visit.endedAt === null
                            ? ''
                            : ` – ${clock(visit.endedAt, project.timezone)}`}
                        </span>
                        {visit.endedAt === null && (
                          <Badge variant="secondary">Under way</Badge>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}

              <Disclosure summary="Record a site visit">
                <SiteVisitForm submit={createSiteVisit.bind(null, id)} />
              </Disclosure>
            </div>
          </Disclosure>

          {/*
            The register of what has been found on this job. Closed issues stay in
            it: the lifecycle is the point of the record, and a list that hid what
            had closed would be the write-up with no follow-up all over again.

            There is no form here. A finding is raised from the observation it was
            seen in, on the walk that produced it, and never typed in from nothing.
          */}
          <Disclosure
            id="issues"
            summary="Issues"
            icon={<ScanSearch aria-hidden />}
            count={issues.length === 0 ? undefined : issues.length}
            detail={
              issues.length === 0
                ? 'Nothing found yet'
                : `${openIssues} open · ${issues.length - openIssues} closed`
            }
          >
            {issues.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                Nothing has been found on this job yet. A finding is raised from
                the observation it was seen in, on the walk that produced it.
              </p>
            ) : (
              <ul className="bg-card divide-y rounded-lg border">
                {issues.map((issue) => (
                  <li key={issue.id}>
                    <Link
                      href={`/projects/${id}/issues/${issue.number}`}
                      className="hover:bg-muted/50 flex flex-wrap items-center gap-3 px-3 py-2 transition-colors"
                    >
                      {/* The identifier, which is what a report prints. */}
                      <Badge variant="outline" className="font-mono">
                        {issue.number}
                      </Badge>
                      <span className="font-medium">{issue.category}</span>
                      <span className="text-muted-foreground text-xs">
                        {/* The latest sighting: where it was last seen, and when. */}
                        {issue.observations.at(-1)?.location} &middot; last seen{' '}
                        {issue.observations.at(-1)?.siteVisit.visitedOn}
                      </span>
                      {issue.closedAt === null ? (
                        <Badge variant="destructive">Open</Badge>
                      ) : (
                        <Badge variant="secondary">
                          Closed {day(issue.closedAt, project.timezone)}
                        </Badge>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Disclosure>

          {/*
            What is stored against the job. There is no count strip here: exposure
            and the clock are the two daily counts and a third figure beside them
            is what ADR-0016 keeps this product from growing — how many documents
            there are is not something to act on in the morning.
          */}
          <Disclosure
            id="documents"
            summary="Documents"
            icon={<FileText aria-hidden />}
            count={documents.length === 0 ? undefined : documents.length}
            detail={
              documents.length === 0
                ? 'Nothing stored yet'
                : `${referenced} referenced of ${documents.length}`
            }
          >
            <div className="space-y-3">
              <DocumentList
                timeZone={project.timezone}
                documents={documents}
                projectId={id}
              />

              <Disclosure summary="Store a document">
                <div className="space-y-3">
                  <p className="text-muted-foreground text-xs">
                    The file goes to object storage and the record keeps what it
                    is and where. A revision is never overwritten, so what a
                    submission was issued against stays answerable.
                  </p>
                  <DocumentForm submit={addDocument.bind(null, id)} />
                </div>
              </Disclosure>
            </div>
          </Disclosure>

          {/*
            What has arrived from outside (issue #19). A section of its own and not
            part of Documents: an arrival carries no title, no revision and no
            referenced-file answer, because nobody has read it — those are what
            extraction proposes and the engineer confirms (issue #20). Nothing here
            is parsed until the engineer asks for an extraction on a file.
          */}
          <Disclosure
            id="arrived"
            summary="Arrived"
            icon={<Inbox aria-hidden />}
            count={arrivals.length === 0 ? undefined : arrivals.length}
            detail={
              arrivals.length === 0
                ? 'Nothing yet'
                : `${forwarded} forwarded of ${arrivals.length}`
            }
          >
            <div className="space-y-3">
              <IngestAddress address={project.ingestAddress} />
              <IngestedDocumentList
                arrivals={arrivals}
                timeZone={project.timezone}
              />

              <Disclosure summary="Record what arrived">
                <div className="space-y-3">
                  <p className="text-muted-foreground text-xs">
                    The fallback, for when something comes by hand or the mail
                    path is down. It makes the same record a forwarded message
                    does, and it is never rate limited.
                  </p>
                  <IngestForm submit={addIngestedDocument.bind(null, id)} />
                </div>
              </Disclosure>
            </div>
          </Disclosure>

          {/*
            Extraction (issue #20). The runs and the proposals awaiting an answer,
            live over the stream. Nothing here commits on its own: a pending one
            links to the confirmation screen, and the register is written only
            there.

            Inside a closed `<details>` the stream still opens — native, so the
            children mount and only stop being painted, which is the same reason
            density rule 1 asks for `<details>` around a half-typed form.
          */}
          <Disclosure
            id="extractions"
            summary="Extractions"
            icon={<ScanText aria-hidden />}
            count={extractions.length === 0 ? undefined : extractions.length}
            detail={
              awaiting === 0
                ? 'Nothing awaiting an answer'
                : `${awaiting} awaiting an answer`
            }
          >
            <div className="space-y-3">
              {/*
                Above the list, because it governs it: a job on local processing
                refuses the ask, so the setting is the first thing to read here
                when nothing can be extracted (issue #21, ADR-0044).
              */}
              <ProcessingLocation project={project} />

              <ExtractionList
                timeZone={project.timezone}
                projectId={id}
                initial={{ extractions }}
              />
            </div>
          </Disclosure>

          {/*
            The curated prose: reasoning and decisions, kept deliberately small
            (issue #18). The size budget rides on every read and is surfaced here
            as the document fills — pushed back against, never enforced, because
            what is worth keeping is the engineer's call and the budget exists to
            inform it.
          */}
          <Disclosure
            id="memory"
            summary="Memory"
            icon={<Brain aria-hidden />}
            detail={
              memory.versions === 0
                ? 'Nothing written yet'
                : `${memory.versions} ${memory.versions === 1 ? 'version' : 'versions'} · ${memory.size.toLocaleString()} of ${memory.budget.toLocaleString()} characters`
            }
            state={
              memory.size > memory.budget ? (
                <Badge variant="destructive">Over budget</Badge>
              ) : undefined
            }
          >
            <div className="space-y-3">
              {/*
                The count links to the versions it counted, the way exposure's and
                the clock's do (issue #63) — before this there was no screen
                anywhere showing a past version, so ADR-0040's "nothing is ever
                overwritten" was true and unobservable. The figure is in the
                summary above, which a `<summary>` cannot nest a link inside, so
                the link is here.
              */}
              {memory.versions > 0 && (
                <Link
                  href={`/projects/${id}/memory`}
                  className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 transition-colors hover:underline"
                >
                  {memory.versions}{' '}
                  {memory.versions === 1 ? 'version' : 'versions'}, oldest first
                </Link>
              )}

              {memory.content !== null && memory.versionedAt !== null && (
                <div className="bg-card rounded-lg border px-3 py-2">
                  <p className="text-base whitespace-pre-wrap">
                    {memory.content}
                  </p>
                  <p className="text-muted-foreground mt-2 text-xs">
                    Last written {day(memory.versionedAt, project.timezone)}
                  </p>
                </div>
              )}

              {/*
                The budget, pushed back against as it fills. Over half it says so;
                over budget it says so in red. A count with no meter would be a
                number nobody reads.
              */}
              <div className="space-y-1">
                <div
                  role="meter"
                  aria-valuenow={memory.size}
                  aria-valuemax={memory.budget}
                  aria-label="Memory size against its budget"
                  className="bg-muted h-1.5 overflow-hidden rounded-full"
                >
                  <div
                    className={
                      memory.size > memory.budget
                        ? 'bg-destructive h-full'
                        : memory.size > memory.budget / 2
                          ? // The one hard-coded colour the product had, and the
                            // only value outside the system: the palette is
                            // achromatic with one hue and that hue means *late, or
                            // unconfirmed*, which a budget over half is not. A chart
                            // grey, which is the token set that exists for a mark
                            // (issue #117, the brief's `## Colour`).
                            'bg-chart-2 h-full'
                          : 'bg-primary h-full'
                    }
                    style={{
                      width: `${Math.min(100, (memory.size / memory.budget) * 100)}%`,
                    }}
                  />
                </div>
                <p
                  className={`text-xs ${
                    memory.size > memory.budget
                      ? 'text-destructive'
                      : 'text-muted-foreground'
                  }`}
                >
                  {memory.size.toLocaleString()} of{' '}
                  {memory.budget.toLocaleString()} characters
                  {memory.size > memory.budget
                    ? ' — over budget; memory stays readable only if it stays small, so cut before you add'
                    : memory.size > memory.budget / 2
                      ? ' — past half; keep it curated'
                      : ''}
                </p>
              </div>

              <MemoryForm projectId={id} current={memory.content} />

              <MemoryActivityList
                projectId={id}
                initial={{ runs: memoryRuns, proposals: memoryProposals }}
              />
            </div>
          </Disclosure>

          {/*
            The project chat (issue #121, ADR-0058 part 4), **last on the record**
            since issue #164: second and open, as plate D-02 drew it, a
            conversation that grows for as long as the job runs buried the record
            it was about. Its turns scroll in a capped list, which the panel does
            for a project and not for a walk. The **latest**
            conversation, which is what the newest-first read answers with first:
            a job has any number of them, and the one anybody is in is the one
            they were last in. Opening a new one is not a control here — nothing
            on the plate draws one, and the first question opens the first
            conversation by itself.

            The panel is on the page **before** there is a conversation, which is
            what makes that true: a GET may not write one, so the typed bar's
            action opens it and then asks.
          */}
          <ConversationPanel
            anchor="conversation"
            turns={conversation?.turns ?? []}
            live={
              <ChatProgress
                conversationId={conversation?.id ?? null}
                initial={conversation?.turns ?? []}
                initialRuns={conversation?.runs ?? []}
              />
            }
            issues={issues}
            timeZone={project.timezone}
            typed={askOnProject.bind(null, id, conversation?.id ?? null)}
            typedPlaceholder="Ask about this job…"
            typedLabel="What you want to know"
            hint={
              <>
                The agent reads this job and asks the helpers. It proposes;
                confirming is yours, and nothing it says is a record until you
                capture it.
              </>
            }
            confirmRecord={(turnId) =>
              confirmAssumptionRecord.bind(null, turnId, id)
            }
            submissions={submissions.map((set) => ({
              id: set.id,
              revision: set.revision,
              phaseName: phaseName.get(set.phaseId) ?? '',
            }))}
          />
        </div>
      </div>
    </div>
  );
}
