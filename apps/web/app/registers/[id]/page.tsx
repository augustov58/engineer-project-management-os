import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import {
  createRegisterEntry,
  requestExtractionFromChosenDocument,
} from '../../actions';
import {
  currentUser,
  getProject,
  getRegister,
  listExtractionTargets,
  listUsers,
  REGISTER_NAMES,
} from '../../api';
import { Disclosure } from '../../disclosure';
import { ExtractFromDocumentForm } from '../../extract-button';
import { SectionHead } from '../../section-head';
import { NewRegisterEntryForm } from '../../register-forms';
import { day } from '../../wall-clock';
import { BallInCourtBadge, ClockBadge } from '../../ball-in-court';

/** The point of this screen is what is in whose court right now. */
export const dynamic = 'force-dynamic';

export default async function RegisterLog({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const register = await getRegister(id);
  if (register === undefined) {
    notFound();
  }

  const [project, targets, users, me] = await Promise.all([
    getProject(register.projectId),
    // What extraction may be pointed at on this job (issue #108). Read from
    // the API's own predicate rather than filtered out of the document list
    // here, so this screen and the route that refuses cannot disagree.
    listExtractionTargets(register.projectId),
    // Who a handoff into our court may name, and who it defaults to
    // (issue #112). Everyone at the firm: there are no roles.
    listUsers(),
    currentUser(),
  ]);
  if (project === undefined) {
    notFound();
  }

  // Only this screen counts them, now that the project screen does not: the
  // number and the rows it describes are the same page, so it cannot come to
  // disagree with what a reader can see under it.
  const ours = register.entries.filter(
    (entry) => entry.ballInCourt?.inOurCourt === true,
  );

  return (
    // The **desk** measure: a register log is rows being compared, which is the
    // half of the brief's `## The spacing scale, and the measure` that stays at
    // 1024 px. The entry it links to is the record-width screen.
    <div className="space-y-6">
      <div>
        <Link
          href={`/projects/${project.id}`}
          className="text-muted-foreground hover:text-foreground font-mono text-xs tracking-[0.06em] uppercase transition-colors"
        >
          &larr; {project.projectNumber} &middot; {project.name}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {REGISTER_NAMES[register.kind]}
        </h1>
      </div>

      <section className="space-y-3">
        <SectionHead
          aside={
            <span className="tabular-nums">
              {register.entries.length === 0
                ? 'none'
                : `${ours.length} of ${register.entries.length} in our court`}
            </span>
          }
        >
          Entries
        </SectionHead>

        {register.entries.length === 0 ? (
          <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
            Nothing has been logged in this register.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {register.entries.map((entry) => {
              const unresolved = entry.openItems.filter(
                (item) => item.resolvedAt === null,
              );
              return (
                <li key={entry.id}>
                  <Link
                    href={`/register-entries/${entry.id}`}
                    className="hover:bg-muted/50 flex flex-wrap items-center gap-3 px-3 py-2 transition-colors"
                  >
                    {/* What it is filed under, which is what anybody quotes. */}
                    <Badge variant="outline" className="font-mono">
                      {entry.number}
                    </Badge>
                    <span className="font-medium">{entry.subject}</span>
                    <span className="text-muted-foreground text-xs">
                      {entry.fromParty} &rarr; {entry.toParty} &middot; logged{' '}
                      {day(entry.createdAt, project.timezone)}
                    </span>
                    <BallInCourtBadge ballInCourt={entry.ballInCourt} />
                    <ClockBadge entry={entry} />
                    {unresolved.length > 0 && (
                      <Badge variant="secondary">
                        {unresolved.length} unresolved
                      </Badge>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Density rule 1: the log shows the log, and what adds to it is closed. */}
      <Disclosure
        summary={`Log ${register.kind === 'RFI' ? 'an RFI' : 'a submittal'}`}
      >
        <div className="space-y-3">
          {/*
            Extraction, offered where the typing happens (issue #108). The
            entry is built from the document instead of typed: asking lands on
            the confirmation screen, where every proposed field is editable
            before anything commits.

            Offered on both registers and not narrowed to RFIs. The agent
            proposes the kind and the confirmation screen carries a Register
            select, so nothing here is RFI-shaped; hiding it on the other
            register would be this screen deciding a predicate that is not its
            own, which is what left the capability unreachable in the first
            place.

            Nothing is offered where there is nothing to point at: a job with
            no document extraction could read has an empty control and no way
            to fill it, and the way in is the Documents section.
          */}
          {targets.length > 0 && (
            <ExtractFromDocumentForm
              documents={targets}
              request={requestExtractionFromChosenDocument.bind(
                null,
                project.id,
              )}
            />
          )}
          <NewRegisterEntryForm
            users={users}
            me={me?.id ?? ''}
            submit={createRegisterEntry.bind(null, register.id, project.id)}
            kind={register.kind}
          />
        </div>
      </Disclosure>
    </div>
  );
}
