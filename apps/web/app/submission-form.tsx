'use client';

import { useActionState, useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { AddState } from './actions';
import type { OpenItem, Phase } from './api';
import { selectClassName } from './native-select';

/** An open item this set may rest on, and whether it starts ticked. */
export interface Offered {
  item: OpenItem;
  /**
   * Carried forward from the set this one replaces (issue #7). Ticked to
   * begin with, and untickable: a reissue must not silently lose what the
   * original rested on, and must not force the engineer to keep it either.
   */
  carried: boolean;
}

/**
 * What went out, to whom, when, and at what phase — one record rather than
 * four scattered facts (issue #5).
 *
 * The same form records a first issuance and a reissue, because they are the
 * same act: nothing edits a submission, and a correction is a new one that
 * supersedes (ADR-0015). Either way this is the moment of issuance — the
 * moment `issued_provisional` is stamped, and so the moment the engineer has
 * to be told what the set is about to go out standing on (issue #6).
 */
export function SubmissionForm({
  submit,
  phases,
  phaseId,
  offered,
  defaults,
  submitLabel,
}: {
  submit: (previous: AddState, formData: FormData) => Promise<AddState>;
  phases: Phase[];
  /** The phase the set is issued at unless the engineer moves it. */
  phaseId: string | null;
  /** Every open item this set may rest on. */
  offered: Offered[];
  /** Prefilled from the superseded set on a reissue; blank on a first one. */
  defaults?: {
    recipient: string;
    recipientRole: string;
    revision: string;
    sheetList: string;
  };
  submitLabel: string;
}) {
  const [state, action, pending] = useActionState(submit, { added: 0 });

  const carriedAny = offered.some((row) => row.carried);

  // Seeded from what comes in ticked, not from zero, so the warning is in the
  // server's HTML rather than arriving after hydration. It has to be: a
  // reissue starts with every carried item ticked, and a state update made
  // from the ref during the hydration commit is discarded — the ref runs, the
  // count is right, and the render keeps the old value. Found by loading the
  // page with two items carried forward and reading the paragraph, which is
  // the only place that showed.
  const [restingOn, setRestingOn] = useState(
    () =>
      offered.filter((row) => row.carried && row.item.resolvedAt === null)
        .length,
  );

  // Read off the form itself rather than counted as the boxes are clicked.
  //
  // A counter drifts: `key` sits on the `<form>`, so recording a set remounts
  // that subtree and clears the boxes, but this state lives on the component
  // and would survive — leaving the warning claiming a set is going out on
  // items nobody has ticked. A reload that restores checked boxes drifts the
  // other way, hiding the warning entirely. The ref is stable, so it fires
  // only on a real mount or unmount, and both cases resync there.
  //
  // Only the unresolved boxes are counted, and the selector says so rather
  // than a set held in a closure — which would have to be a dependency, and
  // would cost the ref the stability the paragraph above depends on. A
  // resolved item carried forward is still something the set rests on; it is
  // not something the set is going out *unsure* of.
  const sync = useCallback((form: HTMLFormElement | null) => {
    setRestingOn(
      form === null
        ? 0
        : form.querySelectorAll(
            'input[name="openItemIds"][data-unresolved="true"]:checked',
          ).length,
    );
  }, []);

  // Keyed on the phase as well as the number recorded. `defaultValue` on an
  // uncontrolled select is applied at mount and never again, so without the
  // phase in the key, making a phase current left this control still showing
  // the old one — and the next set would have been recorded at the wrong
  // stage, silently. Same failure as slice 3's sticky nobody checkbox.
  return (
    <form
      key={`${state.added}:${phaseId ?? ''}`}
      ref={sync}
      onChange={(event) => sync(event.currentTarget)}
      action={action}
      className="space-y-4"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="phaseId">Phase</Label>
          {/* Native, because the action reads this out of FormData. */}
          <select
            id="phaseId"
            name="phaseId"
            required
            defaultValue={phaseId ?? ''}
            className={selectClassName}
          >
            {phases.map((phase) => (
              <option key={phase.id} value={phase.id}>
                {phase.name}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="issuedAt">Issued</Label>
          <Input id="issuedAt" name="issuedAt" type="date" />
          <p className="text-muted-foreground text-sm">Blank means today.</p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="recipient">Issued to</Label>
          <Input
            id="recipient"
            name="recipient"
            required
            defaultValue={defaults?.recipient}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="recipientRole">In what capacity</Label>
          <Input
            id="recipientRole"
            name="recipientRole"
            required
            placeholder="EOR"
            defaultValue={defaults?.recipientRole}
          />
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="revision">Revision</Label>
        <Input
          id="revision"
          name="revision"
          required
          placeholder="Rev 1"
          defaultValue={defaults?.revision}
          className="sm:max-w-48"
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="sheetList">Sheet list</Label>
        <Textarea
          id="sheetList"
          name="sheetList"
          required
          rows={4}
          placeholder={'E0.01\nE1.01\nE2.01'}
          defaultValue={defaults?.sheetList}
          className="font-mono"
        />
        <p className="text-muted-foreground text-sm">
          One sheet per line — this is what makes the defined set defined.
        </p>
      </div>

      {offered.length > 0 && (
        <fieldset className="grid gap-1.5">
          <legend className="mb-1.5 text-sm font-medium">
            What this set rests on
          </legend>
          <div className="space-y-1.5 rounded-lg border p-3">
            {offered.map(({ item, carried }) => (
              <label key={item.id} className="flex items-start gap-2 text-sm">
                {/*
                  Native, and for the same reason as the nobody checkbox: the
                  action reads these with `formData.getAll`, and repeated-name
                  serialisation is exactly the behaviour a styled component
                  would be free to change (ADR-0025).
                */}
                <input
                  type="checkbox"
                  name="openItemIds"
                  value={item.id}
                  defaultChecked={carried}
                  data-unresolved={item.resolvedAt === null}
                  className="accent-primary mt-0.5 size-4"
                />
                <span>
                  {item.unresolved}{' '}
                  <span className="text-muted-foreground">
                    —{' '}
                    {item.resolvedAt === null
                      ? (item.waitingOn ?? 'Nobody')
                      : 'resolved'}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {carriedAny && (
            <p className="text-muted-foreground text-sm">
              Ticked items came forward from the set this replaces. Untick
              anything the reissue no longer stands on.
            </p>
          )}
          {restingOn === 0 ? (
            <p className="text-muted-foreground text-sm">
              Ticking an unresolved one records that this set went out on an
              unconfirmed input.
            </p>
          ) : (
            <p
              role="alert"
              className="border-destructive/50 text-destructive rounded-lg border border-dashed p-3 text-sm"
            >
              This set is going out on {restingOn} unresolved open{' '}
              {restingOn === 1 ? 'item' : 'items'}. Recording it marks the
              submission issued on unconfirmed inputs permanently — resolving
              them later takes it out of exposure but does not unsay it.
            </p>
          )}
        </fieldset>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {submitLabel}
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
