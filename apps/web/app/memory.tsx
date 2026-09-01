'use client';

import { useActionState, useState, useTransition } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  acceptMemoryProposal,
  acceptMemoryProposalEdited,
  rejectMemoryProposal,
  requestMemoryRun,
  writeMemory,
} from './actions';
import type {
  AddState,
} from './actions';
import type { MemoryActivity, MemoryProposal } from './api';
import { useLiveList } from './live-list';
import { diffLines } from './memory-diff';

/** What "renders differently" means for the runs and proposals together. */
function summarise(activity: MemoryActivity): string {
  return activity.runs
    .map((run) => `${run.id}:${run.state}`)
    .concat(
      activity.proposals.map(
        (proposal) => `${proposal.id}:${proposal.state}`,
      ),
    )
    .join('|');
}

/**
 * The engineer writing memory directly. Every word is there because the
 * engineer put it there (story 98); this is the half of that sentence with no
 * agent in it. A write is a new version, never an edit of one that stands.
 */
export function MemoryForm({
  projectId,
  current,
}: {
  projectId: string;
  /** The current text, which the form starts from when one exists. */
  current: string | null;
}) {
  const [state, action, pending] = useActionState(
    writeMemory.bind(null, projectId),
    { added: 0 },
  );
  const [editing, setEditing] = useState(current === null);

  if (!editing) {
    return (
      <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
        Write a new version
      </Button>
    );
  }

  return (
    // Keyed on the number written, so a success starts again from what the
    // memory now says and a refusal leaves the typing exactly where it was.
    <WriteFields
      key={state.added}
      action={action}
      pending={pending}
      error={state.error}
      current={current}
      cancel={current === null ? undefined : () => setEditing(false)}
    />
  );
}

function WriteFields({
  action,
  pending,
  error,
  current,
  cancel,
}: {
  action: (formData: FormData) => void;
  pending: boolean;
  error: string | undefined;
  current: string | null;
  cancel: (() => void) | undefined;
}) {
  return (
    <form action={action} className="space-y-3">
      <div className="grid gap-1.5">
        <Label htmlFor="memory-content">
          {current === null ? 'The memory' : 'The memory, rewritten'}
        </Label>
        <Textarea
          id="memory-content"
          name="content"
          required
          rows={8}
          defaultValue={current ?? undefined}
        />
        <p className="text-muted-foreground text-sm">
          A write is a new version; what the memory said before still stands in
          the history.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {current === null ? 'Write it' : 'Write the new version'}
        </Button>
        {cancel !== undefined && (
          <Button type="button" variant="ghost" size="sm" onClick={cancel}>
            Cancel
          </Button>
        )}
        {error !== undefined && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}

/**
 * The runs in flight and the proposals awaiting an answer, live over the
 * stream (stories 99-100). The agent proposes; the human confirms — and this
 * is the confirming surface: a diff, and accept, edit or reject.
 */
export function MemoryActivityList({
  projectId,
  initial,
}: {
  projectId: string;
  initial: MemoryActivity;
}) {
  const live = useLiveList(
    `/projects/${projectId}/memory/stream`,
    initial,
    summarise,
  );
  const [asking, start] = useTransition();

  const inFlight = live.runs.filter(
    (run) => run.state === 'queued' || run.state === 'running',
  );
  const failed = live.runs.filter((run) => run.state === 'failed');
  const pending = live.proposals.filter(
    (proposal) => proposal.state === 'pending',
  );
  const resolved = live.proposals.filter(
    (proposal) => proposal.state !== 'pending',
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          disabled={asking || inFlight.length > 0}
          onClick={() =>
            start(async () => {
              await requestMemoryRun(projectId);
            })
          }
        >
          Ask the agent for a proposal
        </Button>
        {inFlight.length > 0 && (
          <span className="text-muted-foreground text-sm">
            {inFlight.length === 1 && inFlight[0]?.state === 'queued'
              ? 'Queued…'
              : 'The agent is reading the project…'}
          </span>
        )}
      </div>

      {failed.length > 0 && (
        <ul className="space-y-2">
          {failed.map((run) => (
            <li
              key={run.id}
              className="rounded-lg border border-dashed px-4 py-2 text-sm"
            >
              <span className="text-destructive">The run failed</span>{' '}
              <span className="text-muted-foreground">{run.failure}</span>
            </li>
          ))}
        </ul>
      )}

      {pending.length === 0 && inFlight.length === 0 && (
        <p className="text-muted-foreground text-sm">
          Nothing awaiting an answer.
        </p>
      )}

      <ul className="space-y-4">
        {pending.map((proposal) => (
          <ProposalCard
            key={proposal.id}
            projectId={projectId}
            proposal={proposal}
          />
        ))}
      </ul>

      {resolved.length > 0 && (
        <ul className="space-y-2">
          {resolved.map((proposal) => (
            <li
              key={proposal.id}
              className="text-muted-foreground flex items-center gap-2 text-sm"
            >
              <Badge
                variant={
                  proposal.state === 'accepted' ? 'secondary' : 'outline'
                }
              >
                {proposal.state === 'accepted' ? 'Accepted' : 'Rejected'}
              </Badge>
              <span className="truncate">{firstLine(proposal.proposed)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

/**
 * One proposal: the diff against what the memory said when it was written,
 * and the three answers. Accept takes the agent's words verbatim; edit opens
 * them for correction first — and the proposal keeps the agent's own words,
 * so what the engineer changed stays checkable.
 */
function ProposalCard({
  projectId,
  proposal,
}: {
  projectId: string;
  proposal: MemoryProposal;
}) {
  const [editing, setEditing] = useState(false);
  const [pending, start] = useTransition();
  const diff = diffLines(proposal.baseContent, proposal.proposed);

  return (
    <li className="rounded-lg border">
      <div className="space-y-1 px-4 py-3 font-mono text-sm">
        {diff.map((line, index) => (
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

      {editing ? (
        <EditAndAccept projectId={projectId} proposal={proposal} />
      ) : (
        <div className="flex items-center gap-2 border-t px-4 py-2">
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              start(async () => {
                await acceptMemoryProposal(projectId, proposal.id);
              })
            }
          >
            Accept
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => setEditing(true)}
          >
            Edit and accept
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() =>
              start(async () => {
                await rejectMemoryProposal(projectId, proposal.id);
              })
            }
          >
            Reject
          </Button>
        </div>
      )}
    </li>
  );
}

/** The proposal's text, open for correction before it commits. */
function EditAndAccept({
  projectId,
  proposal,
}: {
  projectId: string;
  proposal: MemoryProposal;
}) {
  const [state, action, pending] = useActionState(
    acceptMemoryProposalEdited.bind(null, projectId, proposal.id),
    { added: 0 } as AddState,
  );

  return (
    <form action={action} className="space-y-3 border-t px-4 py-3">
      <Textarea
        name="content"
        required
        rows={8}
        defaultValue={proposal.proposed}
        className="font-mono text-sm"
      />
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          Accept the edited text
        </Button>
        {state.error !== undefined && (
          <p role="alert" className="text-destructive text-sm">
            {state.error}
          </p>
        )}
      </div>
    </form>
  );
}
