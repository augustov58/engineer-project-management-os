'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { writeCounterfactual, type AddState } from './actions';

/**
 * Capturing what a helper skill produced (issue #8). Two blocks, pasted as
 * they were printed, plus the code edition and the date.
 *
 * Both blocks are textareas rather than a repeater of entries, because the act
 * this form exists for is a paste. Asking the engineer to enter each
 * assumption as its own field would be the transcription by hand that the
 * whole record type is there to avoid; the lines are what get addressed
 * afterwards, and the API splits them.
 */
export function AssumptionRecordForm({
  submit,
}: {
  submit: (previous: AddState, formData: FormData) => Promise<AddState>;
}) {
  const [state, action, pending] = useActionState(submit, { added: 0 });

  // Keyed on the number captured, so a success starts a genuinely empty form
  // and a rejection leaves the pasted blocks exactly where they were.
  return (
    <form key={state.added} action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="codeEdition">Code edition</Label>
          <Input
            id="codeEdition"
            name="codeEdition"
            required
            placeholder="NEC 2023"
          />
          <p className="text-muted-foreground text-sm">
            Every standard the calculation was run against — a later code cycle
            must not silently reinterpret this.
          </p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="calculatedAt">Calculated</Label>
          <Input id="calculatedAt" name="calculatedAt" type="date" />
          <p className="text-muted-foreground text-sm">Blank means today.</p>
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="assumptions">ASSUMPTIONS block</Label>
        <Textarea
          id="assumptions"
          name="assumptions"
          required
          rows={6}
          placeholder={'ASSUMPTIONS:\n  - Secondary OCPD present'}
          className="font-mono"
        />
        <p className="text-muted-foreground text-sm">
          Paste it exactly as the helper skill printed it. Nothing is
          reformatted, and each line is what a counterfactual is written
          against.
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="flags">FLAGS / VERIFY block</Label>
        <Textarea
          id="flags"
          name="flags"
          required
          rows={6}
          placeholder={'FLAGS / VERIFY:\n  ! Electrode type not given'}
          className="font-mono"
        />
        <p className="text-muted-foreground text-sm">
          Each line can be raised as an open item once this is captured, so a
          flag cannot be raised during a calculation and then forgotten.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          Capture the record
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
 * What changes if one assumed input turns out wrong, written against the line
 * it is about. Refused rather than overwritten if the input already carries
 * one, so the API's message is what shows here.
 */
export function CounterfactualForm({
  recordId,
  line,
  submissionId,
}: {
  recordId: string;
  line: number;
  submissionId: string;
}) {
  const [state, action, pending] = useActionState(
    writeCounterfactual.bind(null, recordId, line, submissionId),
    { added: 0 },
  );

  return (
    <form
      key={state.added}
      action={action}
      className="mt-2 flex flex-wrap items-center gap-2"
    >
      <Input
        name="counterfactual"
        required
        placeholder="What changes if this turns out wrong"
        className="min-w-56 flex-1"
      />
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        Add
      </Button>
      {state.error !== undefined && (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      )}
    </form>
  );
}
