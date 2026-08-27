'use client';

import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AddState } from './actions';

/**
 * The form is the same wherever an open item is raised; what differs is where
 * it lands. The caller binds that in and passes the action, so the project
 * screen and a submission screen share one set of fields rather than two that
 * can drift.
 */
export function NewOpenItemForm({
  submit,
  unresolved,
  submitLabel = 'Add open item',
}: {
  submit: (
    previous: AddState,
    formData: FormData,
  ) => Promise<AddState>;
  /**
   * What is unresolved, already filled in. Present only where the item is
   * being raised from something that already says it — a `FLAGS / VERIFY`
   * entry (issue #8) — so that its wording is not retyped. Editable, because
   * a terse flag is sometimes worth saying at length.
   */
  unresolved?: string;
  submitLabel?: string;
}) {
  const [state, action, pending] = useActionState(submit, { added: 0 });

  // Keyed on the number of items added, so a success starts a genuinely empty
  // form and a rejection leaves everything typed exactly where it was.
  return (
    <Fields
      key={state.added}
      action={action}
      pending={pending}
      error={state.error}
      unresolved={unresolved}
      submitLabel={submitLabel}
    />
  );
}

function Fields({
  action,
  pending,
  error,
  unresolved,
  submitLabel,
}: {
  action: (formData: FormData) => void;
  pending: boolean;
  error: string | undefined;
  unresolved: string | undefined;
  submitLabel: string;
}) {
  // Nobody is a real answer, so it is a control of its own rather than the
  // absence of one. Ticking it takes the party field out of play entirely.
  //
  // Deliberately a native checkbox rather than the Radix one: the action reads
  // `formData.get('nobody')`, and this control's exact form semantics are the
  // subtlest thing on the screen.
  const [nobody, setNobody] = useState(false);

  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-1.5">
        <Label htmlFor="unresolved">What is unresolved</Label>
        <Input
          id="unresolved"
          name="unresolved"
          required
          defaultValue={unresolved}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="blocks">What it blocks</Label>
          <Input id="blocks" name="blocks" required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="counterfactual">
            What changes if the assumption is wrong
          </Label>
          <Input id="counterfactual" name="counterfactual" required />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="waitingOn">Who owes the next move</Label>
          <Input
            id="waitingOn"
            name="waitingOn"
            required={!nobody}
            disabled={nobody}
          />
          <label className="text-muted-foreground flex items-center gap-2 text-sm">
            <input
              name="nobody"
              type="checkbox"
              checked={nobody}
              onChange={(event) => setNobody(event.target.checked)}
              className="accent-primary size-4"
            />
            Nobody owes the next move
          </label>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="waitingSince">Open since</Label>
          <Input id="waitingSince" name="waitingSince" type="date" />
          <p className="text-muted-foreground text-sm">Blank means today.</p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="invalidationTrigger">
            Invalidation trigger{' '}
            <span className="text-muted-foreground font-normal">optional</span>
          </Label>
          <Input id="invalidationTrigger" name="invalidationTrigger" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="owner">
            Owner{' '}
            <span className="text-muted-foreground font-normal">optional</span>
          </Label>
          <Input id="owner" name="owner" />
        </div>
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
