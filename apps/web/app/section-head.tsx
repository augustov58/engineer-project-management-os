import type { ReactNode } from 'react';

/**
 * The **Section** step of the type scale (issue #118, the approved design
 * brief's `## The type scale`): 12/16, uppercase, 600, tracking 0.08em, muted,
 * with a rule under it.
 *
 * A component rather than a class string repeated on every `h2`, because the
 * count beside the heading is part of the step: the brief's plates draw the
 * head as one baseline-aligned row with the figure pushed to the end, and a
 * screen that spelled that itself would be free to spell it differently on the
 * next section. `text-lg font-medium` — 35 of them across the product — is
 * what this replaces, and it is the single largest source of the page lengths
 * the density rules are against.
 *
 * `aside` is whatever the section counts or the state it is in: `3`, `12 on
 * this walk`, a live SSE span. It sits inside the heading because on the plate
 * it is part of the head rather than a line under it.
 */
export function SectionHead({
  id,
  children,
  aside,
}: {
  /** The jumper's anchor, where the screen carries one. */
  id?: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <h2
      id={id}
      className="text-muted-foreground flex items-baseline justify-between gap-3 border-b pb-1.5 text-xs font-semibold tracking-[0.08em] uppercase"
    >
      <span>{children}</span>
      {/*
        The figure is not part of the uppercase step: the plates draw it with
        `text-transform:none; letter-spacing:0`, because a tracked-out uppercase
        `12 on this walk` is a number nobody can read at a glance.
      */}
      {aside !== undefined && (
        <span className="font-normal tracking-normal normal-case">{aside}</span>
      )}
    </h2>
  );
}
