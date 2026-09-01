'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { confirmExtraction, rejectExtraction } from './actions';
import type { AddState } from './actions';
import type { Extraction, ExtractionActivity, ExtractionDetail } from './api';
import { useLiveList } from './live-list';
import { selectClassName } from './native-select';
import { day } from './open-item';

/** What "renders differently" means for the extraction list. */
function summarise(activity: ExtractionActivity): string {
  return activity.extractions
    .map((extraction) => `${extraction.id}:${extraction.state}`)
    .join('|');
}

const STATE_LABEL: Record<Extraction['state'], string> = {
  queued: 'Queued',
  running: 'Reading',
  failed: 'Failed',
  finished: 'Read — nothing to propose',
  pending: 'Awaiting confirmation',
  confirmed: 'Confirmed',
  rejected: 'Rejected',
};

/**
 * The extractions asked for on this job, live over the stream (story 90).
 *
 * What the engineer watches is the state — queued, reading, the proposal
 * arriving — never a percentage. A pending one links to the confirmation
 * screen, where the proposal sits beside what the agent read.
 */
export function ExtractionList({
  projectId,
  initial,
}: {
  projectId: string;
  initial: ExtractionActivity;
}) {
  const live = useLiveList(
    `/projects/${projectId}/extractions/stream`,
    initial,
    summarise,
  );

  if (live.extractions.length === 0) {
    return (
      <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
        No extractions yet. Ask for one from a file that arrived, or from a
        stored document.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {live.extractions.map((extraction) => (
        <li
          key={extraction.id}
          className="flex flex-wrap items-center gap-3 rounded-lg border px-4 py-2 text-sm"
        >
          <span className="font-medium break-all">
            {extraction.source.filename}
          </span>
          <Badge
            variant={
              extraction.state === 'failed'
                ? 'destructive'
                : extraction.state === 'pending'
                  ? 'default'
                  : extraction.state === 'confirmed'
                    ? 'secondary'
                    : 'outline'
            }
          >
            {STATE_LABEL[extraction.state]}
          </Badge>
          {extraction.state === 'pending' && (
            <>
              <span className="text-muted-foreground">
                {extraction.proposedKind === 'RFI' ? 'RFI' : 'Submittal'}{' '}
                {extraction.proposedNumber}
              </span>
              <Link
                href={`/projects/${projectId}/extractions/${extraction.id}`}
                className="underline underline-offset-4"
              >
                Review and confirm
              </Link>
            </>
          )}
          {extraction.state === 'failed' && (
            <span className="text-destructive">{extraction.failure}</span>
          )}
          {extraction.state === 'confirmed' &&
            extraction.registerEntryId !== null && (
              <Link
                href={`/register-entries/${extraction.registerEntryId}`}
                className="text-muted-foreground underline underline-offset-4"
              >
                the entry it became
              </Link>
            )}
          <span className="text-muted-foreground ml-auto text-xs">
            asked {day(extraction.createdAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The confirmation: every extracted field, editable, preseeded with what the
 * agent proposed (story 87). Confirming writes the document (on the mail
 * path), the register entry and its first handoff in one action; rejecting
 * keeps the source and the proposal as they stand.
 *
 * The kind select is a native element, as the phase and attachment selects
 * are (ADR-0025): which kind it is decides whether the question field is in
 * the form at all, and a styled control that serialised differently would
 * file an RFI's question under a submittal rather than fail.
 */
export function ExtractionConfirmForm({
  projectId,
  extraction,
}: {
  projectId: string;
  extraction: ExtractionDetail;
}) {
  const arrivalPath = extraction.ingestedDocumentFileId !== null;
  const [state, action, pending] = useActionState(
    confirmExtraction.bind(null, projectId, extraction.id, arrivalPath),
    { added: 0 } as AddState,
  );
  const [kind, setKind] = useState<'SUBMITTAL' | 'RFI'>(
    extraction.proposedKind ?? 'RFI',
  );
  const [rejecting, setRejecting] = useState(false);

  return (
    <form action={action} className="space-y-4">
      {arrivalPath && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="extract-title">Document title</Label>
            <Input
              id="extract-title"
              name="title"
              required
              maxLength={200}
              defaultValue={extraction.proposedTitle ?? undefined}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="extract-revision">Revision</Label>
            <Input
              id="extract-revision"
              name="revision"
              required
              maxLength={32}
              defaultValue={extraction.proposedRevision ?? undefined}
            />
            <p className="text-muted-foreground text-xs">
              The designation printed on it &mdash; &quot;C&quot;, &quot;Rev
              2&quot;. Nothing here allocates one.
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="extract-kind">Register</Label>
          <select
            id="extract-kind"
            name="kind"
            className={selectClassName}
            value={kind}
            onChange={(event) =>
              setKind(event.target.value === 'RFI' ? 'RFI' : 'SUBMITTAL')
            }
          >
            <option value="RFI">RFI</option>
            <option value="SUBMITTAL">Submittal</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="extract-number">Number</Label>
          <Input
            id="extract-number"
            name="number"
            required
            maxLength={32}
            defaultValue={extraction.proposedNumber ?? undefined}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="extract-subject">Subject</Label>
          <Input
            id="extract-subject"
            name="subject"
            required
            maxLength={200}
            defaultValue={extraction.proposedSubject ?? undefined}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="extract-fromParty">From</Label>
          <Input
            id="extract-fromParty"
            name="fromParty"
            required
            maxLength={120}
            defaultValue={extraction.proposedFromParty ?? undefined}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="extract-toParty">To</Label>
          <Input
            id="extract-toParty"
            name="toParty"
            required
            maxLength={120}
            defaultValue={extraction.proposedToParty ?? undefined}
          />
        </div>
      </div>

      {kind === 'RFI' && (
        <div className="space-y-1.5">
          <Label htmlFor="extract-question">Question</Label>
          <Textarea
            id="extract-question"
            name="question"
            required
            rows={3}
            maxLength={2000}
            defaultValue={extraction.proposedQuestion ?? undefined}
          />
        </div>
      )}

      {kind === 'RFI' && (
        <div className="space-y-1.5">
          <Label htmlFor="extract-response">Response, if it already carries one</Label>
          <Textarea
            id="extract-response"
            name="response"
            rows={2}
            maxLength={2000}
            defaultValue={extraction.proposedResponse ?? undefined}
          />
        </div>
      )}

      <div className="space-y-1.5 sm:max-w-56">
        <Label htmlFor="extract-turnaroundDays">Turnaround target</Label>
        <Input
          id="extract-turnaroundDays"
          name="turnaroundDays"
          type="number"
          min={1}
          max={365}
          step={1}
          defaultValue={extraction.proposedTurnaroundDays ?? undefined}
        />
        <p className="text-muted-foreground text-xs">
          Whole days, off the contract. Left blank it can be set later &mdash;
          once, either way.
        </p>
      </div>

      <fieldset className="space-y-3 rounded-lg border p-3">
        <legend className="text-muted-foreground px-1 text-sm">
          Whose court it starts in
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="extract-party">Whose court</Label>
            <Input
              id="extract-party"
              name="party"
              required
              maxLength={120}
              defaultValue={extraction.proposedParty ?? undefined}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="extract-heldSince">Since</Label>
            <Input
              id="extract-heldSince"
              name="heldSince"
              type="date"
              defaultValue={
                extraction.proposedHeldSince?.slice(0, 10) ?? undefined
              }
            />
            <p className="text-muted-foreground text-xs">
              The date on the document. Left blank, today.
            </p>
          </div>
        </div>
        <label className="text-muted-foreground flex items-center gap-2 text-sm">
          <input
            name="inOurCourt"
            type="checkbox"
            className="accent-primary size-4"
            defaultChecked={extraction.proposedInOurCourt ?? true}
          />
          It is in our court
        </label>
      </fieldset>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending || rejecting}>
          Confirm and log the entry
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={pending || rejecting}
          onClick={async () => {
            setRejecting(true);
            try {
              await rejectExtraction(projectId, extraction.id);
            } finally {
              setRejecting(false);
            }
          }}
        >
          Reject — keep the source
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
