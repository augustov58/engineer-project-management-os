'use client';

import { useActionState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { setProcessingLocation } from './actions';
import type { Project } from './api';
import { day } from './open-item';

/**
 * The reference and the date, which only ever travel together and only ever
 * to `CLOUD`. Both branches below render it, differing in nothing but the
 * button, so it is one component rather than the same twenty-five lines twice.
 */
function SignoffForm({
  action,
  pending,
  label,
  variant,
}: {
  action: (formData: FormData) => void;
  pending: boolean;
  label: string;
  variant?: 'outline';
}) {
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="location" value="CLOUD" />
      <div className="grid gap-1.5">
        <Label htmlFor="signoffReference">Written sign-off reference</Label>
        <Input
          id="signoffReference"
          name="signoffReference"
          required
          placeholder="DPA-2026-014"
          className="min-w-48 font-mono"
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="signoffAt">Date signed</Label>
        <Input id="signoffAt" name="signoffAt" type="date" required />
      </div>
      <Button type="submit" variant={variant} disabled={pending}>
        {label}
      </Button>
    </form>
  );
}

/**
 * Where this job's documents are read, and what the firm signed (issue #21,
 * stories 91 and 92).
 *
 * The setting and the sign-off are one panel because they are one decision:
 * ADR-0044 settles the vault's contradiction in ADR-0013's favour, so a job
 * arrives on cloud with nothing signed, and a screen that showed the location
 * without saying whether anybody had agreed to it would be showing the less
 * important half. The copy says which way the default falls, since the
 * default is the answer for every job nobody has thought about.
 *
 * Switching to local needs no form and no confirmation: consent can be
 * withdrawn, and putting a step in front of stopping the sending would be the
 * wrong friction to add. Switching back is what carries the fields.
 */
export function ProcessingLocation({ project }: { project: Project }) {
  const [error, action, pending] = useActionState(
    setProcessingLocation.bind(null, project.id),
    undefined,
  );
  const local = project.processingLocation === 'LOCAL';

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Processing location</span>
        <Badge variant={local ? 'outline' : 'secondary'}>
          {local ? 'Local' : 'Cloud'}
        </Badge>
      </div>

      <p className="text-muted-foreground text-xs">
        {local
          ? 'Documents on this job are not sent to an OCR vendor. Extraction is refused, and entering a document by hand is the path.'
          : 'Documents on this job may be read by a third-party OCR vendor when an extraction is asked for. This is the default for a new job.'}
      </p>

      {project.cloudSignoffReference !== null && (
        <p className="text-sm">
          Signed off in writing:{' '}
          <span className="font-mono">{project.cloudSignoffReference}</span>
          {project.cloudSignoffAt !== null && (
            <span className="text-muted-foreground">
              {' '}
              &mdash; {day(project.cloudSignoffAt)}
            </span>
          )}
        </p>
      )}

      {local ? (
        <SignoffForm action={action} pending={pending} label="Switch to cloud processing" />
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          {project.cloudSignoffReference === null && (
            // The only way a job that was never switched records what the firm
            // agreed to. Recording it is not a second sign-off; it is the
            // first, and a second is refused.
            <SignoffForm
              action={action}
              pending={pending}
              label="Record the sign-off"
              variant="outline"
            />
          )}

          <form action={action}>
            <input type="hidden" name="location" value="LOCAL" />
            <Button type="submit" variant="outline" disabled={pending}>
              Switch to local processing
            </Button>
          </form>
        </div>
      )}

      {error !== undefined && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
