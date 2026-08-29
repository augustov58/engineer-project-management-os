'use client';

import { useActionState, useRef, useState, useTransition } from 'react';
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
 * The whole selection is picked at once — sorting a hundred by hand is the
 * work this removes — but sent **one request per photograph**, because a
 * server action's body is capped and a hundred files of two to four megabytes
 * in one body is not a request anybody should make. That is why this form
 * drives the loop itself instead of handing one `FormData` to an action the
 * way every other form here does; the count and the refusal come back per
 * file, which is what a hundred photographs needs.
 */
export function PhotoForm({
  add,
}: {
  add: (file: File, takenAt: string) => Promise<string | undefined>;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<File[]>([]);
  const [state, setState] = useState<AddState>({ added: 0 });
  const [pending, start] = useTransition();

  function submit() {
    if (chosen.length === 0) {
      setState({ added: state.added, error: 'no photographs were chosen' });
      return;
    }

    start(async () => {
      let added = 0;
      let error: string | undefined;

      for (const file of chosen) {
        const refused = await add(file, asTypedInstant(file.lastModified));
        if (refused === undefined) {
          added += 1;
          continue;
        }
        // The first refusal, carrying the file it was about: out of a hundred
        // photographs, "the API returned 409" is not an answer anybody can
        // act on.
        error ??= `${file.name}: ${refused}`;
      }

      // Cleared on the way out so the next selection starts empty, which the
      // native input needs told directly — remounting it is what the `key` on
      // every other form here is for, and there is no action state to key on.
      setChosen([]);
      if (picker.current !== null) {
        picker.current.value = '';
      }
      setState({
        added: state.added + added,
        error:
          error === undefined || chosen.length === 1
            ? error
            : `${error} — ${added} of ${chosen.length} added`,
      });
    });
  }

  return (
    <form action={submit} className="space-y-4">
      <div className="grid gap-1.5">
        <Label htmlFor="photos">Photographs</Label>
        {/*
          Native, and not only because there is no styled equivalent: this is
          the control that carries the files, and ADR-0025 keeps the native
          element wherever a styled one would change what a form serialises.
        */}
        <input
          id="photos"
          ref={picker}
          name="photos"
          type="file"
          multiple
          accept={ACCEPT}
          onChange={(event) => setChosen(Array.from(event.target.files ?? []))}
          className="file:text-foreground file:bg-transparent file:border-0 file:text-sm file:font-medium border-input w-full rounded-lg border bg-transparent px-3 py-1.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <p className="text-muted-foreground text-sm">
          Each one bins to a floor by its time against the schedule above, and
          to a finding by its name — <code>issue-12</code>, <code>ISS-12</code>{' '}
          or <code>iss_12</code> anywhere in it. Anything neither mechanism can
          place is left unbound rather than guessed at.
        </p>
      </div>

      {chosen.length > 0 && (
        <ul className="divide-y rounded-lg border text-sm">
          {chosen.map((file, index) => (
            <li
              // Two files of the same name can be picked from two folders, so
              // the position is part of what makes this row itself.
              key={`${index}-${file.name}`}
              className="flex flex-wrap items-baseline justify-between gap-3 px-3 py-2"
            >
              <span className="font-medium break-all">{file.name}</span>
              <span className="text-muted-foreground tabular-nums">
                {asTypedInstant(file.lastModified).slice(11, 16)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending
            ? 'Adding…'
            : chosen.length > 1
              ? `Add ${chosen.length} photographs`
              : 'Add the photograph'}
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
