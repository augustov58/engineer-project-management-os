import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getMemory,
  getProject,
  listMemoryProposals,
  listMemoryVersions,
} from '../../../api';
import { MemoryHistory } from '../../../memory-versions';

/** The history of a record nothing overwrites; read on every request. */
export const dynamic = 'force-dynamic';

/**
 * What this job's memory has ever said (issue #63).
 *
 * A page and not a feature: `GET /v1/projects/:id/memory/versions` was built
 * and tested with slice 17 and `listMemoryVersions` had been imported by
 * nothing since. ADR-0040 made memory versions on the project so that nothing
 * is overwritten and accept-with-edit keeps the agent's words; until this
 * screen, that guarantee was true and unobservable.
 *
 * Reverting to a past version is deliberately not here. That is a write, and
 * whether reverting is a new version (it should be) is an ADR rather than a
 * button.
 */
export default async function MemoryHistoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (project === undefined) {
    notFound();
  }

  const [memory, versions, proposals] = await Promise.all([
    // For the budget each version is read against, which is the same number
    // the project screen meters the current one against.
    getMemory(id),
    listMemoryVersions(id),
    // Not a list of proposals — how each accepted version arrived is read off
    // the proposal it points at, and the agent's own words are the comparison.
    listMemoryProposals(id),
  ]);

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
          What the memory has said
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {versions.length === 0
            ? 'Nothing written yet.'
            : `${versions.length} ${versions.length === 1 ? 'version' : 'versions'}, newest first. Nothing here was ever overwritten: a write is a new version, and accepting a proposal with an edit keeps the agent's own words on the proposal.`}
        </p>
      </div>

      <MemoryHistory
        versions={versions}
        proposals={proposals}
        budget={memory.budget}
      />
    </div>
  );
}
