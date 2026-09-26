import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';

/**
 * A creation form behind a disclosure (issue #118, the design brief's density
 * rule 1): *"A record screen shows the record; the form that adds to it is a
 * native `<details>`, closed, its summary a button-shaped row saying what it
 * adds."*
 *
 * **Native, so the `<form>` inside is untouched** — ADR-0025's rule, the same
 * one that keeps every select the native element. A disclosure built out of
 * state and a conditional render would unmount the form on close and lose what
 * was half typed into it; `<details>` only stops painting it.
 *
 * The summary is a 44 px row, which is density rule 6's field target and clears
 * its desk one (≥ 32 px). `list-none` plus the WebKit marker rule removes the
 * platform triangle so the chevron is the only affordance. It was a `+` / `−`
 * until the second design pass (ADR-0069, issue #169), which also put the
 * disclosure on the sheet: the page is a tinted canvas now, and a closed
 * disclosure is a row of the record rather than a hole in the page.
 *
 * A **record section** passes more (the plan's `SectionCard`, issue #175): an
 * icon, its count, one line saying what is in it, and a state in the legend's
 * words. A stack of identical 44 px bars said nothing about the job until each
 * was opened. A creation form passes none of them and reads as it did.
 */
export function Disclosure({
  summary,
  children,
  open = false,
  id,
  icon,
  count,
  detail,
  state,
}: {
  /** What it adds, said as the button it looks like. */
  summary: string;
  children: ReactNode;
  /** The jumper's anchor, where the screen carries one. */
  id?: string;
  /** A rendered icon, decorative: the title says it. */
  icon?: ReactNode;
  /** How many the section holds, left off where it holds none. */
  count?: number;
  /** One line saying what is in it, so the closed card says something. */
  detail?: ReactNode;
  /** A legend badge, always a word (ADR-0069 D1). */
  state?: ReactNode;
  /**
   * Density rule 3's other half (issue #120): *"A **finished** section is
   * collapsed and carries its count in the summary… Open by default only when
   * empty of nothing."* A creation form is always closed; a section holding
   * **live work** — items still unresolved — opens itself, because collapsing
   * what is outstanding is the opposite of what the rule is for.
   *
   * The attribute and not state: a `<details open>` is still the native
   * element and the engineer's tap still closes it.
   */
  open?: boolean;
}) {
  return (
    <details
      id={id}
      open={open}
      className="group bg-card scroll-mt-14 rounded-lg border shadow-xs"
    >
      <summary className="hover:bg-muted/50 flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-lg px-4 py-2 text-sm font-medium transition-colors group-open:rounded-b-none group-open:border-b [&::-webkit-details-marker]:hidden">
        {icon !== undefined && (
          <span className="bg-muted text-muted-foreground inline-flex size-8 shrink-0 items-center justify-center rounded-md [&_svg]:size-4">
            {icon}
          </span>
        )}
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span data-slot="title">{summary}</span>
            {count !== undefined && (
              <Badge variant="secondary" className="tabular-nums">
                {count}
              </Badge>
            )}
          </span>
          {detail !== undefined && (
            <span className="text-muted-foreground block text-xs font-normal">
              {detail}
            </span>
          )}
        </span>
        {state !== undefined && (
          <span className="ml-auto shrink-0">{state}</span>
        )}
        <ChevronRight
          aria-hidden
          className={`text-muted-foreground size-4 shrink-0 transition-transform ${state === undefined ? 'ml-auto' : ''} group-open:rotate-90 motion-reduce:transition-none`}
        />
      </summary>
      <div className="p-4">{children}</div>
    </details>
  );
}
