import { CircleDot } from 'lucide-react';
import type { Phase } from './api';

/**
 * The job's phases in the order it runs them, the current one marked (ADR-0069,
 * the plan's `PhaseStrip`; issue #175). They were a list inside a closed
 * disclosure, so which phase a job was in was two taps deep.
 *
 * **Only the current phase is marked.** The record says which phase a new
 * submission defaults to and nothing about whether the ones before it are
 * finished, so the strip draws no progress: a filled bar behind the current one
 * would be a claim nobody made. The mark is a glyph beside the blueprint bar,
 * and a word to a screen reader: never colour alone.
 *
 * Below `sm` only the current phase's name is shown, and its cell is wider,
 * since five names do not fit across a 390 px phone. The others stay in the
 * accessibility tree.
 */
export function PhaseStrip({
  phases,
  currentPhaseId,
}: {
  phases: Phase[];
  currentPhaseId: string | null;
}) {
  if (phases.length === 0) {
    return null;
  }
  return (
    <ol aria-label="Phases" className="flex gap-1.5">
      {phases.map((phase) => {
        const current = phase.id === currentPhaseId;
        return (
          <li
            key={phase.id}
            aria-current={current ? 'step' : undefined}
            className={`min-w-0 ${current ? 'flex-[4] sm:flex-1' : 'flex-1'}`}
          >
            <span
              aria-hidden
              className={`block h-1 rounded-full ${current ? 'bg-primary' : 'bg-border'}`}
            />
            <span
              title={phase.name}
              className={`mt-1.5 truncate text-xs ${
                current
                  ? 'text-primary flex items-center gap-1 font-medium'
                  : 'text-muted-foreground sr-only sm:not-sr-only sm:block'
              }`}
            >
              {current && (
                <CircleDot aria-hidden className="size-3 shrink-0" />
              )}
              <span className="truncate">{phase.name}</span>
              {current && <span className="sr-only"> (current)</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
