import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { createRegisterEntry } from '../../actions';
import { getProject, getRegister, REGISTER_NAMES } from '../../api';
import { NewRegisterEntryForm } from '../../register-forms';
import { day } from '../../open-item';
import { BallInCourtBadge } from '../../ball-in-court';

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

  const project = await getProject(register.projectId);
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
    <div className="space-y-8">
      <div>
        <Link
          href={`/projects/${project.id}`}
          className="text-muted-foreground hover:text-foreground text-sm transition-colors"
        >
          &larr; {project.projectNumber} {project.name}
        </Link>
        <h1 className="mt-2 text-2xl font-medium">
          {REGISTER_NAMES[register.kind]}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {register.entries.length === 0
            ? 'Nothing logged yet.'
            : `${ours.length} of ${register.entries.length} in our court.`}
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Entries</h2>

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
                    className="hover:bg-muted/50 flex flex-wrap items-center gap-3 px-4 py-3 transition-colors"
                  >
                    {/* What it is filed under, which is what anybody quotes. */}
                    <Badge variant="outline" className="font-mono">
                      {entry.number}
                    </Badge>
                    <span className="font-medium">{entry.subject}</span>
                    <span className="text-muted-foreground text-sm">
                      {entry.fromParty} &rarr; {entry.toParty} &middot; logged{' '}
                      {day(entry.createdAt)}
                    </span>
                    <BallInCourtBadge ballInCourt={entry.ballInCourt} />
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

      <Card>
        <CardHeader>
          <CardTitle>
            Log {register.kind === 'RFI' ? 'an RFI' : 'a submittal'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <NewRegisterEntryForm
            submit={createRegisterEntry.bind(null, register.id, project.id)}
            kind={register.kind}
          />
        </CardContent>
      </Card>
    </div>
  );
}
