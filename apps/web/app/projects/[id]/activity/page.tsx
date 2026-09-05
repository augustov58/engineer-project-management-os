import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getProject, listActivity } from '../../../api';

/** A read over a record nothing overwrites; read on every request. */
export const dynamic = 'force-dynamic';

/**
 * What happened on this job lately (story 107, issue #83, ADR-0048).
 *
 * `GET /v1/projects/:id/activity` shipped with story 107 and had **no
 * consumer** — the guarantee was built, tested and unobservable, which is the
 * same gap issue #63 closed for memory versions. This is the consumer.
 *
 * It is not the audit under another name, and the difference is the whole
 * point of the ticket. The audit read answers *what is the compliance
 * history*: every line, oldest first, unbounded. This answers *what happened
 * here lately*: the same rows, newest first, bounded. Two questions, two
 * answers, one record — a second stream would be a second place the same fact
 * lives, with sixty-two writers of its own.
 *
 * **Nothing here is a figure.** ADR-0048 is explicit that this list's length
 * is not a count, unlike exposure's and the clock's: those are lists whose
 * length *is* the answer, and this one is bounded, so its length is the bound
 * or less. Rendering `37` would say "37 things happened" where the truth is
 * "at least 37, and 50 was what was asked for". ADR-0016 keeps this product to
 * two daily figures and this is not a third.
 *
 * **No limit control, and that is deliberate.** The route's `?limit=` maximum
 * of 200 is load-bearing rather than a page size (ADR-0048): a screen that
 * paged through it would be the compliance record with a next button on it,
 * and the two questions would collapse back into one. Asking for all of it
 * means the audit read, which is where all of it lives, and which the memory
 * screen still links to.
 */
export default async function ProjectActivityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (project === undefined) {
    notFound();
  }

  const activity = await listActivity(id);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/projects/${id}`}
          className="text-muted-foreground hover:text-foreground text-sm transition-colors"
        >
          &larr; {project.projectNumber} &mdash; {project.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          What happened lately
        </h1>
        {/*
          Prose and never a number. The list is bounded, so saying how long it
          is would state a figure that is not the count of anything.
        */}
        <p className="text-muted-foreground mt-1 text-sm">
          Every recorded change on this job, newest first. The most recent are
          shown; the whole record, oldest first, is the audit.
        </p>
      </div>

      {/*
        A job's feed is never empty in practice — recording the job writes the
        first line of its own audit (story 106) — so this is the state of a
        record that predates the widening, not of a job where nothing has
        happened.
      */}
      {activity.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
          Nothing recorded on this job yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {activity.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border p-3 text-sm"
            >
              <span className="text-muted-foreground tabular-nums">
                {entry.createdAt.slice(0, 10)}{' '}
                {entry.createdAt.slice(11, 16)}
              </span>
              <span className="font-medium">{entry.action}</span>
              <span className="text-muted-foreground">{entry.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
