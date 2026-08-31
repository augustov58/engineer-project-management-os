'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { selectClassName } from './native-select';
import type { AddState } from './actions';
import type { RegisterKind, Submission } from './api';

type Submit = (previous: AddState, formData: FormData) => Promise<AddState>;

/** The button and the API's own message, which every form here ends with. */
function Submitted({
  pending,
  error,
  label,
}: {
  pending: boolean;
  error: string | undefined;
  label: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <Button type="submit" disabled={pending}>
        {label}
      </Button>
      {error !== undefined && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Whose court, and from when — the three fields a handoff is.
 *
 * The checkbox is the whole of "ours". It is deliberately not inferred from
 * the party name: a job that calls us by the firm's name still accrues, and
 * the clock (issue #15) sums exactly this box.
 */
function HandoffFields({ legend }: { legend: string }) {
  return (
    <fieldset className="space-y-3 rounded-lg border p-3">
      <legend className="text-muted-foreground px-1 text-sm">{legend}</legend>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="party">Whose court</Label>
          <Input
            id="party"
            name="party"
            required
            maxLength={120}
            placeholder="Acme Mechanical"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="heldSince">Since</Label>
          <Input id="heldSince" name="heldSince" type="date" />
          <p className="text-muted-foreground text-xs">
            Left blank, today. A transmittal log written up afterwards is dated
            when the ball actually moved.
          </p>
        </div>
      </div>

      {/*
        Native rather than the Radix checkbox, for the reason the nobody
        checkbox is (ADR-0025): the action reads `formData.get('inOurCourt')`,
        and this is the field issue #15's accrual sums. A styled control that
        serialised differently would make the clock quietly wrong rather than
        visibly broken.
      */}
      <label className="text-muted-foreground flex items-center gap-2 text-sm">
        <input
          name="inOurCourt"
          type="checkbox"
          className="accent-primary size-4"
        />
        It is in our court
      </label>
    </fieldset>
  );
}

/**
 * Log a piece of correspondence.
 *
 * The first handoff is part of this form and not a second step: an entry
 * logged is already sitting in somebody's court, and an entry whose current
 * holder was nobody would be a row this screen could not render.
 */
export function NewRegisterEntryForm({
  submit,
  kind,
}: {
  submit: Submit;
  kind: RegisterKind;
}) {
  const [state, action, pending] = useActionState(submit, { added: 0 });

  // Keyed on the number added, so a success starts a genuinely empty form and
  // a rejection leaves everything typed exactly where it was.
  return (
    <form key={state.added} action={action} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="number">Number</Label>
          <Input
            id="number"
            name="number"
            required
            maxLength={32}
            placeholder={kind === 'RFI' ? 'RFI-012' : '23 05 93-1.1'}
          />
          <p className="text-muted-foreground text-xs">
            As it is filed on the job. Nothing here allocates one.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="subject">Subject</Label>
          <Input
            id="subject"
            name="subject"
            required
            maxLength={200}
            placeholder={
              kind === 'RFI'
                ? 'Load at the north stair'
                : 'Rooftop unit shop drawings'
            }
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="fromParty">From</Label>
          <Input
            id="fromParty"
            name="fromParty"
            required
            maxLength={120}
            placeholder="Acme Mechanical"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="toParty">To</Label>
          <Input
            id="toParty"
            name="toParty"
            required
            maxLength={120}
            placeholder="Us"
          />
        </div>
      </div>

      {kind === 'RFI' && (
        <div className="space-y-1.5">
          <Label htmlFor="question">Question</Label>
          <Textarea
            id="question"
            name="question"
            required
            rows={3}
            maxLength={2000}
            placeholder="What is the load at the north stair?"
          />
          <p className="text-muted-foreground text-xs">
            The answer is recorded on the entry when it comes back.
          </p>
        </div>
      )}

      <HandoffFields legend="Whose court it starts in" />

      <Submitted
        pending={pending}
        error={state.error}
        label={kind === 'RFI' ? 'Log the RFI' : 'Log the submittal'}
      />
    </form>
  );
}

/**
 * Hand the ball on.
 *
 * Every handoff is a row and none is ever rewritten, which is what makes a
 * turnaround dispute settleable by the record rather than by memory.
 */
export function HandoffForm({ submit }: { submit: Submit }) {
  const [state, action, pending] = useActionState(submit, { added: 0 });

  return (
    <form key={state.added} action={action} className="space-y-3">
      <HandoffFields legend="Where it goes next" />
      <Submitted pending={pending} error={state.error} label="Hand it on" />
    </form>
  );
}

/** What came back. Recorded once; the API refuses a second. */
export function ResponseForm({ submit }: { submit: Submit }) {
  const [state, action, pending] = useActionState(submit, { added: 0 });

  return (
    <form key={state.added} action={action} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="response">Response</Label>
        <Textarea
          id="response"
          name="response"
          required
          rows={3}
          maxLength={2000}
          placeholder="4.2 kN, per the structural drawings issued 2026-06-30."
        />
      </div>
      <Submitted
        pending={pending}
        error={state.error}
        label="Record the response"
      />
    </form>
  );
}

/**
 * The issuance that answered this entry, so a resubmittal and its issuance are
 * one story.
 *
 * Offered only where the job has issuances to point at, because an empty
 * select is a control that cannot be used.
 */
export function LinkSubmissionForm({
  submit,
  submissions,
  phaseName,
}: {
  submit: Submit;
  submissions: Submission[];
  phaseName: Map<string, string>;
}) {
  const [state, action, pending] = useActionState(submit, { added: 0 });

  return (
    <div className="space-y-1">
      <form
        key={state.added}
        action={action}
        className="flex flex-wrap items-end gap-2"
      >
        {/* Native, because the action reads this out of FormData (ADR-0025). */}
        <select
          name="submissionId"
          required
          aria-label="The issuance that responded to this entry"
          defaultValue=""
          className={`${selectClassName} min-w-56 flex-1`}
        >
          <option value="" disabled>
            The issuance that responded&hellip;
          </option>
          {submissions.map((issued) => (
            <option key={issued.id} value={issued.id}>
              {phaseName.get(issued.phaseId) ?? 'Unknown phase'} &mdash;{' '}
              {issued.revision}, {issued.issuedAt.slice(0, 10)}
            </option>
          ))}
        </select>
        <Button type="submit" variant="secondary" disabled={pending}>
          Link
        </Button>
      </form>
      {state.error !== undefined && (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      )}
    </div>
  );
}
