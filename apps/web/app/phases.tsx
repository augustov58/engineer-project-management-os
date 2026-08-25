import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { reorderPhases, setCurrentPhase } from './actions';
import type { Phase } from './api';
import { RenamePhaseForm } from './rename-phase-form';

/** The list with one pair swapped, which is what the reorder route takes. */
function swap(ids: string[], from: number, to: number): string[] {
  if (to < 0 || to >= ids.length) {
    return ids;
  }
  const next = [...ids];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

/**
 * A project's phases: free text the engineer types, in an order he sets.
 * Some jobs run 50% CD and others go straight to 90% CD, so this is a list
 * per project and never a set shared across them (ADR-0015).
 *
 * Renaming propagates to every submission issued at the phase — a rename is
 * the same body of work under a better name, and a past submission that keeps
 * the typo is wrong rather than faithful (ADR-0026).
 */
export function PhaseList({
  phases,
  projectId,
  currentPhaseId,
}: {
  phases: Phase[];
  projectId: string;
  currentPhaseId: string | null;
}) {
  const ids = phases.map((phase) => phase.id);

  return (
    <ul className="divide-y rounded-lg border">
      {phases.map((phase, index) => (
        <li key={phase.id} className="flex flex-wrap items-center gap-2 p-3">
          <RenamePhaseForm
            projectId={projectId}
            phaseId={phase.id}
            name={phase.name}
          />

          <div className="flex items-center gap-1">
            <form action={reorderPhases.bind(null, projectId, swap(ids, index, index - 1))}>
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={index === 0}
                aria-label={`Move ${phase.name} earlier`}
              >
                &uarr;
              </Button>
            </form>
            <form action={reorderPhases.bind(null, projectId, swap(ids, index, index + 1))}>
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={index === phases.length - 1}
                aria-label={`Move ${phase.name} later`}
              >
                &darr;
              </Button>
            </form>
          </div>

          {phase.id === currentPhaseId ? (
            <Badge variant="secondary">Current</Badge>
          ) : (
            <form action={setCurrentPhase.bind(null, projectId, phase.id)}>
              <Button type="submit" variant="ghost" size="sm">
                Make current
              </Button>
            </form>
          )}
        </li>
      ))}
    </ul>
  );
}
