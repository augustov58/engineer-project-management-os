import { Badge } from '@/components/ui/badge';
import type { MemoryProposal, MemoryVersion } from './api';
import { diffLines } from './memory-diff';
import { day } from './open-item';

/**
 * A line diff, drawn the one way this product draws one (issue #63).
 *
 * Written for a proposal under review and reused for two adjacent versions:
 * the question either answers is "what changed", and two renderings of it
 * would be the second place the same fact lives. No `'use client'` here, so
 * the history reads it from a server component and `memory.tsx` compiles it
 * into the client bundle it already ships.
 */
export function DiffView({
  base,
  proposed,
}: {
  base: string | null;
  proposed: string;
}) {
  return (
    <div className="space-y-1 px-4 py-3 font-mono text-sm">
      {diffLines(base, proposed).map((line, index) => (
        <p
          key={index}
          className={
            line.kind === 'added'
              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
              : line.kind === 'removed'
                ? 'bg-red-500/10 text-red-700 line-through dark:text-red-400'
                : 'text-muted-foreground'
          }
        >
          {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}
          {line.text}
        </p>
      ))}
    </div>
  );
}

/**
 * How a version arrived, derived on read from the proposal it points at and
 * stored nowhere.
 *
 * `proposal_id` null is the engineer's own writing; set is an accept, and
 * whether the text is the agent's own is the same comparison the accept route
 * makes when it picks between its two audit lines — the content against what
 * the agent proposed. A column saying which would be a second answer to a
 * question the two rows already answer together.
 */
function arrival(
  version: MemoryVersion,
  proposals: Map<string, MemoryProposal>,
): string {
  if (version.proposalId === null) {
    return 'written by hand';
  }
  const proposal = proposals.get(version.proposalId);
  if (proposal === undefined) {
    return 'accepted from a proposal';
  }
  return proposal.proposed === version.content
    ? 'accepted from a proposal'
    : 'accepted with an edit';
}

/**
 * What the memory has ever said, newest first (issue #63).
 *
 * ADR-0040 made memory versions on the project precisely so that nothing is
 * overwritten — accept-with-edit writes a version and keeps the agent's
 * words. This screen is where that guarantee becomes observable: until it
 * existed the earlier text survived somewhere nobody could read.
 *
 * Newest first, which is the API's oldest-first answer reversed and nothing
 * else: the current memory is the first row here, and the diff under each
 * version is against the one it replaced.
 */
export function MemoryHistory({
  versions,
  proposals,
  budget,
}: {
  /** Oldest first, as the API answers. */
  versions: MemoryVersion[];
  /** Every proposal on this job, so an accept can say how it arrived. */
  proposals: MemoryProposal[];
  /** The size to read each version against. Surfaced, never enforced. */
  budget: number;
}) {
  const byId = new Map(proposals.map((proposal) => [proposal.id, proposal]));

  return (
    <ul className="space-y-4">
      {versions
        .map((version, index) => ({
          version,
          // What it replaced. Null on the first version, which is what
          // `diffLines` already takes for "the memory said nothing yet".
          previous: index === 0 ? null : versions[index - 1]!.content,
          // Counting from one, oldest first, so the number does not move as
          // versions are added above it. Not `seq`, which is the tie-break
          // and never reaches the wire.
          ordinal: index + 1,
        }))
        .reverse()
        .map(({ version, previous, ordinal }, index) => (
          <li key={version.id} className="rounded-lg border">
            <div className="flex flex-wrap items-baseline gap-3 px-4 py-3">
              <Badge variant="outline" className="font-mono">
                {ordinal}
              </Badge>
              {index === 0 && <Badge variant="secondary">Current</Badge>}
              <span className="text-muted-foreground text-sm tabular-nums">
                {day(version.createdAt)}
              </span>
              <span className="text-muted-foreground text-sm">
                {arrival(version, byId)}
              </span>
              <span
                className={`text-sm tabular-nums ${
                  version.content.length > budget
                    ? 'text-destructive'
                    : 'text-muted-foreground'
                }`}
              >
                {version.content.length.toLocaleString()} of{' '}
                {budget.toLocaleString()} characters
              </span>
            </div>

            <p className="border-t px-4 py-3 text-sm whitespace-pre-wrap">
              {version.content}
            </p>

            <details className="border-t text-sm">
              <summary className="text-muted-foreground cursor-pointer px-4 py-2">
                {previous === null
                  ? 'What it added to nothing'
                  : 'What changed from the version before it'}
              </summary>
              <DiffView base={previous} proposed={version.content} />
            </details>
          </li>
        ))}
    </ul>
  );
}
