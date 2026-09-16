'use client';

import { useActionState, useRef, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { selectClassName } from './native-select';
import { EVIDENCES_NOTHING, evidenceValue } from './photo-evidence';
import { clock } from './wall-clock';
import type { AddState } from './actions';

/** The four the API stores, so the picker offers only what it will accept. */
const ACCEPT = 'image/jpeg,image/png,image/heic,image/webp';

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
  timeZone,
}: {
  add: (file: File, takenAt: string) => Promise<string | undefined>;
  /** The zone of the building, which is what these times are read in. */
  timeZone: string;
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
        // The instant the file already carries, sent as it is (ADR-0054).
        // `asTypedInstant` used to shift it into the fake-UTC frame so it
        // would bin against typed floor windows: the one value here that was
        // always a real instant was being corrupted to match the ones that
        // were not. It is deleted, and the windows are instants now too.
        const refused = await add(
          file,
          new Date(file.lastModified).toISOString(),
        );
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
                {clock(new Date(file.lastModified).toISOString(), timeZone)}
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
 * The bindings on one photograph, each corrected in one action — the quality
 * bar ADR-0025 holds this ticket to, so every select submits on the change
 * rather than waiting for a second click on a button beside them.
 *
 * **Two controls, not three** (issue #113, ADR-0056). The floor is its own,
 * because the mechanisms are independent: a photograph binned to the wrong
 * floor and bound to the right finding needs one of them fixed and not both
 * restated. What it *evidences* is one control for one fact — a photograph
 * evidences at most one of an observation and a finding, and moving it between
 * the two is the single action the ADR asks for rather than an unbind and a
 * bind.
 */
export function PhotoBindings({
  floor,
  floors,
  observationId,
  observations,
  issueNumber,
  issues,
  timeZone,
  bindFloor,
  bindEvidence,
}: {
  floor: string | null;
  /** Every floor this walk knows about, scheduled or merely observed on. */
  floors: string[];
  observationId: string | null;
  /** This walk's observations, in the order they were made. */
  observations: { id: string; location: string; observedAt: string }[];
  issueNumber: number | null;
  issues: { number: number; category: string }[];
  /** The zone of the building, which is what these times are read in. */
  timeZone: string;
  bindFloor: (formData: FormData) => void;
  bindEvidence: (formData: FormData) => void;
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

      <form action={bindEvidence}>
        <select
          name="evidences"
          aria-label="What this photograph is evidence of"
          defaultValue={evidenceValue({ observationId, issueNumber })}
          onChange={(event) => event.currentTarget.form?.requestSubmit()}
          className={selectClassName}
        >
          {/* Unfiled, and named as the report names it: a photograph on a floor
              and nothing else prints nowhere. */}
          <option value={EVIDENCES_NOTHING}>Unfiled</option>
          {observations.length > 0 && (
            <optgroup label="Observations">
              {observations.map((observation) => (
                <option
                  key={observation.id}
                  value={evidenceValue({
                    observationId: observation.id,
                    issueNumber: null,
                  })}
                >
                  {clock(observation.observedAt, timeZone)} ·{' '}
                  {observation.location}
                </option>
              ))}
            </optgroup>
          )}
          {issues.length > 0 && (
            <optgroup label="Findings">
              {issues.map((issue) => (
                <option
                  key={issue.number}
                  value={evidenceValue({
                    observationId: null,
                    issueNumber: issue.number,
                  })}
                >
                  Issue {issue.number} · {issue.category}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </form>
    </div>
  );
}

/**
 * The unfiled photographs on this observation's floor, offered on the
 * observation's own row (issue #113, ADR-0056).
 *
 * The first use the floor binding has had beyond the report. Binding one is a
 * single action, so this submits on the change like every other control here,
 * and the picture leaves the shortlist because it is no longer unfiled.
 *
 * Rendered by the caller only when there is something in it: an empty picker
 * under every observation on a walk with no loose photographs is a control
 * that can do nothing, which is not the same as a count of zero.
 */
export function EvidenceShortlist({
  photos,
  timeZone,
  bind,
}: {
  photos: { id: string; filename: string; takenAt: string }[];
  timeZone: string;
  bind: (formData: FormData) => void;
}) {
  return (
    <form action={bind}>
      {/* Native, because the action reads this out of FormData (ADR-0025). */}
      <select
        name="photoId"
        aria-label="An unfiled photograph from this floor"
        defaultValue=""
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
        className={selectClassName}
      >
        <option value="" disabled>
          {photos.length === 1
            ? 'Attach the unfiled photograph on this floor'
            : `Attach one of ${photos.length} unfiled photographs on this floor`}
        </option>
        {photos.map((photo) => (
          <option key={photo.id} value={photo.id}>
            {clock(photo.takenAt, timeZone)} · {photo.filename}
          </option>
        ))}
      </select>
    </form>
  );
}
