'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { renamePhase } from './actions';

/**
 * Renaming a phase rewrites what every submission issued at it says it was
 * issued at, deliberately (ADR-0026) — so a refusal has to be visible rather
 * than leaving the old name back in the field with no explanation.
 */
export function RenamePhaseForm({
  projectId,
  phaseId,
  name,
}: {
  projectId: string;
  phaseId: string;
  name: string;
}) {
  const [state, action, pending] = useActionState(
    renamePhase.bind(null, projectId, phaseId),
    { added: 0 },
  );

  return (
    <div className="min-w-56 flex-1">
      <form action={action} className="flex items-center gap-2">
        <Input
          key={`${state.added}:${name}`}
          name="name"
          defaultValue={name}
          required
          aria-label={`Name of ${name}`}
          className="flex-1"
        />
        <Button type="submit" variant="ghost" size="sm" disabled={pending}>
          Rename
        </Button>
      </form>
      {state.error !== undefined && (
        <p role="alert" className="text-destructive mt-1 text-sm">
          {state.error}
        </p>
      )}
    </div>
  );
}
