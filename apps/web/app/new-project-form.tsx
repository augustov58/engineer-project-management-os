'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createProject } from './actions';
import { selectClassName } from './native-select';

/**
 * Starting a job.
 *
 * The zone is **required with no default** (ADR-0054): the control opens on a
 * blank option the browser refuses to submit, rather than on the author's own
 * zone, because a default classifies by omission and the omitted answer would
 * date every walk on the job in a zone nobody chose.
 *
 * A native select for ADR-0025's reason — a styled one serialises nothing into
 * the form — and the list is handed in from the server rather than read here,
 * so the options the browser hydrates over are the ones it was sent. Two ICU
 * versions do not have to agree for the page to come up.
 */
export function NewProjectForm({ zones }: { zones: string[] }) {
  const [error, action, pending] = useActionState(createProject, undefined);

  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="projectNumber">Project number</Label>
        <Input
          id="projectNumber"
          name="projectNumber"
          required
          placeholder="T-1"
          className="w-28 font-mono"
        />
      </div>

      <div className="grid flex-1 gap-1.5">
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" required className="min-w-48" />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="timezone">Timezone</Label>
        <select
          id="timezone"
          name="timezone"
          required
          defaultValue=""
          className={selectClassName}
        >
          <option value="" disabled>
            The building&rsquo;s zone
          </option>
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </div>

      <Button type="submit" disabled={pending}>
        Add project
      </Button>

      {error !== undefined && (
        <p role="alert" className="text-destructive w-full text-sm">
          {error}
        </p>
      )}
    </form>
  );
}
