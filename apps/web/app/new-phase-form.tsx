'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createPhase } from './actions';

/**
 * Keyed on the number added, so a success starts an empty field and a
 * rejection — a name already on this project — leaves what was typed alone.
 */
export function NewPhaseForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState(
    createPhase.bind(null, projectId),
    { added: 0 },
  );

  return (
    <div className="space-y-2">
      <form key={state.added} action={action} className="flex flex-wrap gap-2">
        <Input
          name="name"
          required
          placeholder="50% CD"
          aria-label="New phase name"
          className="min-w-48 flex-1"
        />
        <Button type="submit" variant="secondary" disabled={pending}>
          Add phase
        </Button>
      </form>
      {state.error !== undefined && (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      )}
    </div>
  );
}
