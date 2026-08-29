'use client';

import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { selectClassName } from './native-select';
import type { AddState } from './actions';

/** The four the API stores, so the picker offers only what it will accept. */
const ACCEPT = 'image/jpeg,image/png,image/heic,image/webp';

/**
 * The wall clock the engineer was reading, written the way a typed time is.
 *
 * A file's `lastModified` is a real instant; a floor started at 13:00 typed
 * into the schedule was stored as `13:00Z` whatever zone it was typed in.
 * ADR-0030 left that product-wide timezone decision open deliberately and
 * noted that the screens are written so a walk stays in one frame. Sending
 * the photograph's true UTC instant would put it in the other one, and every
 * photograph of the afternoon would bin to nothing by the engineer's offset.
 *
 * So the local wall clock goes up as though it were UTC, which is exactly what
 * `composeInstant` does with a time the engineer types. When the product takes
 * the timezone decision, this and that helper change together.
 */
function asTypedInstant(lastModified: number): string {
  const local = new Date(lastModified);
  const offset = local.getTimezoneOffset() * 60_000;
  return new Date(lastModified - offset).toISOString();
}

/**
 * Adding the walk's photographs.
 *
 * The whole selection at once: sorting a hundred by hand is the work this
 * removes, and a one-at-a-time picker would be that afternoon back.
 */
export function PhotoForm({
  submit,
}: {
  submit: (previous: AddState, formData: FormData) => Promise<AddState>;
}) {
  const [state, action, pending] = useActionState(submit, { added: 0 });

  return (
    <Fields
      key={state.added}
      action={action}
      pending={pending}
      error={state.error}
    />
  );
}

function Fields({
  action,
  pending,
  error,
}: {
  action: (formData: FormData) => void;
  pending: boolean;
  error: string | undefined;
}) {
  // What the browser knows about each picked file and the server cannot be
  // told any other way.
  const [chosen, setChosen] = useState<{ name: string; takenAt: string }[]>([]);

  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-1.5">
        <Label htmlFor="photos">Photographs</Label>
        {/*
          Native, and not only because there is no styled equivalent: the
          action reads the files straight out of FormData, which is the rule
          ADR-0025 keeps every select in this product native for.
        */}
        <input
          id="photos"
          name="photos"
          type="file"
          multiple
          accept={ACCEPT}
          onChange={(event) =>
            setChosen(
              Array.from(event.target.files ?? []).map((file) => ({
                name: file.name,
                takenAt: asTypedInstant(file.lastModified),
              })),
            )
          }
          className="file:text-foreground file:bg-transparent file:border-0 file:text-sm file:font-medium border-input w-full rounded-lg border bg-transparent px-3 py-1.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <p className="text-muted-foreground text-sm">
          Each one bins to a floor by its time against the schedule above, and
          to a finding by its name — <code>issue-12</code>, <code>ISS-12</code>{' '}
          or <code>iss_12</code> anywhere in it. Anything neither mechanism can
          place is left unbound rather than guessed at.
        </p>
      </div>

      {chosen.map((file, index) => (
        <input
          // Two files of the same name can be picked from two folders, so the
          // position is part of what makes this row itself.
          key={`${index}-${file.name}`}
          type="hidden"
          name="takenAt"
          value={file.takenAt}
        />
      ))}

      {chosen.length > 0 && (
        <ul className="divide-y rounded-lg border text-sm">
          {chosen.map((file, index) => (
            <li
              key={`${index}-${file.name}`}
              className="flex flex-wrap items-baseline justify-between gap-3 px-3 py-2"
            >
              <span className="font-medium">{file.name}</span>
              <span className="text-muted-foreground tabular-nums">
                {file.takenAt.slice(11, 16)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {chosen.length > 1
            ? `Add ${chosen.length} photographs`
            : 'Add the photograph'}
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

/**
 * The two bindings on one photograph, each corrected in one action — the
 * quality bar ADR-0025 holds this ticket to, so both selects submit on the
 * change rather than waiting for a second click on a button beside them.
 *
 * Two controls and not one, because the mechanisms are independent: a
 * photograph binned to the wrong floor and bound to the right finding needs
 * one of them fixed and not both restated.
 */
export function PhotoBindings({
  floor,
  floors,
  issueNumber,
  issues,
  bindFloor,
  bindIssue,
}: {
  floor: string | null;
  /** Every floor this walk knows about, scheduled or merely observed on. */
  floors: string[];
  issueNumber: number | null;
  issues: { number: number; category: string }[];
  bindFloor: (formData: FormData) => void;
  bindIssue: (formData: FormData) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <form action={bindFloor}>
        {/* Native, because the action reads this out of FormData (ADR-0025). */}
        <select
          name="floor"
          aria-label="The floor this photograph was taken on"
          defaultValue={floor ?? ''}
          onChange={(event) => event.currentTarget.form?.requestSubmit()}
          className={selectClassName}
        >
          <option value="">No floor</option>
          {floors.map((named) => (
            <option key={named} value={named}>
              Floor {named}
            </option>
          ))}
          {/* A correction may name a floor nobody formally started, and one
              already binned to such a floor must still read as itself. */}
          {floor !== null && !floors.includes(floor) && (
            <option value={floor}>Floor {floor}</option>
          )}
        </select>
      </form>

      <form action={bindIssue}>
        <select
          name="issueNumber"
          aria-label="The finding this photograph is evidence of"
          defaultValue={issueNumber === null ? '' : String(issueNumber)}
          onChange={(event) => event.currentTarget.form?.requestSubmit()}
          className={selectClassName}
        >
          <option value="">No finding</option>
          {issues.map((issue) => (
            <option key={issue.number} value={issue.number}>
              Issue {issue.number} · {issue.category}
            </option>
          ))}
        </select>
      </form>
    </div>
  );
}
