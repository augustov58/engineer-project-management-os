'use client';

import { useActionState, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { selectClassName } from './native-select';
import type { AddState } from './actions';

/**
 * Recording a walk. One date and two clock times, because that is how a visit
 * is described — "the 23rd, one till half four" — while the record keeps two
 * instants and derives the date from the start.
 *
 * The end may be left blank. The per-floor schedule is recorded during the
 * visit, so a walk has to be able to exist before it is over.
 */
export function SiteVisitForm({
  submit,
}: {
  submit: (previous: AddState, formData: FormData) => Promise<AddState>;
}) {
  const [state, action, pending] = useActionState(submit, { added: 0 });

  return (
    <form key={state.added} action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="visitedOn">Date</Label>
          <Input id="visitedOn" name="visitedOn" type="date" required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="startedAt">Started</Label>
          {/*
            Both required, together. A time without a day cannot be composed
            into an instant, and a form that accepted one would have to either
            guess the day or drop what was typed.
          */}
          <Input id="startedAt" name="startedAt" type="time" required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="endedAt">
            Ended{' '}
            <span className="text-muted-foreground font-normal">optional</span>
          </Label>
          <Input id="endedAt" name="endedAt" type="time" />
          <p className="text-muted-foreground text-sm">
            Leave blank while you are still walking.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          Record the visit
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

/** Arriving on a floor. One field, because that is the whole act. */
export function StartFloorForm({
  submit,
}: {
  submit: (previous: AddState, formData: FormData) => Promise<AddState>;
}) {
  const [state, action, pending] = useActionState(submit, { added: 0 });

  return (
    <div className="space-y-2">
      <form key={state.added} action={action} className="flex flex-wrap gap-2">
        <Input
          name="floor"
          required
          placeholder="3"
          aria-label="Floor to start"
          className="min-w-32 flex-1"
        />
        {/*
          Blank is now, which is the case on the walk itself. Filled in is a
          visit being entered afterwards, whose real floor times are the
          window issue #11 bins photographs against.
        */}
        <Input
          name="startedAt"
          type="time"
          aria-label="Time this floor was started"
          className="w-32"
        />
        <Button type="submit" variant="secondary" disabled={pending}>
          Start floor
        </Button>
      </form>
      <p className="text-muted-foreground text-sm">
        The designation without the word Floor &mdash; 3, B1, M, PH. A blank
        time means now.
      </p>
      {state.error !== undefined && (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      )}
    </div>
  );
}

/**
 * Recording an observation.
 *
 * A single column with controls sized to be hit without looking: this is the
 * one screen used one-handed on a phone while walking (ADR-0025).
 *
 * Side and Sector are **one control with two settings**, not two fields. They
 * are independent axes that never combine in one string, and two fields side
 * by side would be an invitation to fill both in — which is exactly the
 * corruption by the interface that story 55 is about. The API refuses both
 * anyway; this makes it unsayable.
 */
export function ObservationForm({
  submit,
}: {
  submit: (previous: AddState, formData: FormData) => Promise<AddState>;
}) {
  const [state, action, pending] = useActionState(submit, { added: 0 });

  return (
    <ObservationFields
      key={state.added}
      action={action}
      pending={pending}
      error={state.error}
    />
  );
}

/**
 * The observation fields themselves, so the screen that corrects a transcript
 * is the screen that types one (issue #12).
 *
 * Exported rather than copied. ADR-0025 asks for one act to be one control,
 * and two forms drifting apart is how the one-axis rule gets weakened on the
 * newer of them — which is precisely what ADR-0030 warned a later writer would
 * do. "Voice will replace the typing, not the layout" is that ADR's sentence
 * about this ticket, and this is what it looks like.
 */
export function ObservationFields({
  action,
  pending,
  error,
  defaultObserved,
  submitLabel = 'Record the observation',
  timeHint = 'Blank means now.',
}: {
  action: (formData: FormData) => void;
  pending: boolean;
  error: string | undefined;
  /** What the vendor heard, for the engineer to correct. */
  defaultObserved?: string;
  submitLabel?: string;
  timeHint?: string;
}) {
  // Native, because the action reads this out of FormData and the axis and
  // its value have to arrive together (ADR-0025).
  const [axis, setAxis] = useState<'side' | 'sector'>('side');

  // One per instance. A walk with three drafts awaiting review renders four of
  // these at once, and a fixed `id` would give every label on the page the
  // same target — so tapping "Floor" would focus the typed form's field
  // whichever draft you were reading.
  const field = useId();

  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-1.5">
        <Label htmlFor={`${field}-observed`}>What you observed</Label>
        <Textarea
          id={`${field}-observed`}
          name="observed"
          required
          rows={3}
          // Uncontrolled and seeded, so the transcript is what the engineer
          // starts from and every keystroke after that is theirs.
          defaultValue={defaultObserved}
        />
        <p className="text-muted-foreground text-sm">
          Most observations are not findings, and this one stays an
          observation.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${field}-floor`}>Floor</Label>
          <Input id={`${field}-floor`} name="floor" required placeholder="3" />
          <p className="text-muted-foreground text-sm">3, B1, M, PH.</p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${field}-qualifier`}>Qualifier</Label>
          <Input
            id={`${field}-qualifier`}
            name="qualifier"
            required
            placeholder="Stair B"
          />
          <p className="text-muted-foreground text-sm">
            A landmark, a room number with a type gloss, a circulation element,
            a program space, or an equipment tag.
          </p>
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${field}-axisValue`}>Side or Sector</Label>
        <div className="flex flex-wrap gap-2">
          <select
            name="axis"
            aria-label="Which axis"
            value={axis}
            onChange={(event) =>
              setAxis(event.target.value === 'sector' ? 'sector' : 'side')
            }
            className={selectClassName}
          >
            <option value="side">Side</option>
            <option value="sector">Sector</option>
          </select>
          <Input
            id={`${field}-axisValue`}
            name="axisValue"
            required
            placeholder={axis === 'side' ? 'A' : '4'}
            className="min-w-32 flex-1"
          />
        </div>
        <p className="text-muted-foreground text-sm">
          Independent axes: one or the other, never both in one string.
        </p>
      </div>

      <div className="grid gap-1.5">
        {/*
          The time only. The day is the visit's, so there is no date field to
          leave blank and no way for a typed time to be dropped for want of
          one — and one less control to hit on a phone.
        */}
        <Label htmlFor={`${field}-observedAt`}>Observed at</Label>
        <Input id={`${field}-observedAt`} name="observedAt" type="time" />
        <p className="text-muted-foreground text-sm">{timeHint}</p>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {submitLabel}
        </Button>
        {error !== undefined && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}
