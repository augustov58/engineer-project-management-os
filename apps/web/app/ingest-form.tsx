'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AddState } from './actions';

type Submit = (previous: AddState, formData: FormData) => Promise<AddState>;

/**
 * Entering a document by hand (story 93).
 *
 * The fallback, so it asks for as little as possible: a line about what
 * arrived, the files, and nothing else. There is no title, no revision and no
 * referenced-file answer here on purpose — those are what a document carries,
 * and nobody has read this yet.
 */
export function IngestForm({ submit }: { submit: Submit }) {
  const [state, action, pending] = useActionState(submit, { added: 0 });

  // Keyed on the number added, so a success starts a genuinely empty form and
  // a rejection leaves everything typed exactly where it was.
  return (
    <form key={state.added} action={action} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="ingest-note">What arrived</Label>
        <Input
          id="ingest-note"
          name="note"
          maxLength={2000}
          placeholder="Handed to me on site by the mechanical contractor"
        />
        <p className="text-muted-foreground text-xs">
          A line for you, kept as you typed it. Nothing reads it.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="ingest-files">Files</Label>
        <Input id="ingest-files" name="files" type="file" multiple />
        <p className="text-muted-foreground text-xs">
          Any type. Nothing is opened, parsed or sent anywhere &mdash; the file
          is stored as it is and what it says stays unread until extraction.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          Record what arrived
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
