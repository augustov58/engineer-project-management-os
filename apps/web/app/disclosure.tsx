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
 * The summary is a 44 px row on the field screens, which is density rule 6.
 * `list-none` plus the WebKit marker rule removes the platform triangle so the
 * `+` / `−` below is the only affordance, as the plates draw it.
 */
export function Disclosure({
  summary,
  children,
}: {
  /** What it adds, said as the button it looks like. */
  summary: string;
  children: ReactNode;
}) {
  return (
    <details className="group rounded-lg border">
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
