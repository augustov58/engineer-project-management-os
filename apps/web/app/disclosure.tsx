import type { ReactNode } from 'react';

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
 * platform triangle so the `+` / `−` below is the only affordance, as the
 * plates draw it.
 */
export function Disclosure({
  summary,
  children,
  open = false,
}: {
  /** What it adds, said as the button it looks like. */
  summary: string;
  children: ReactNode;
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
    <details open={open} className="group rounded-lg border">
      <summary className="flex min-h-11 list-none items-center gap-2 px-4 text-sm font-medium group-open:border-b [&::-webkit-details-marker]:hidden">
        <span className="text-muted-foreground font-mono">
          <span className="group-open:hidden">+</span>
          <span className="hidden group-open:inline">&minus;</span>
        </span>
        {summary}
      </summary>
      <div className="p-4">{children}</div>
    </details>
  );
}
