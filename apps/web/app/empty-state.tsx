import type { ReactNode } from 'react';

/**
 * A list with nothing in it, said as the answer it is (ADR-0069, the plan's
 * `EmptyState`; issue #173). On the daily layer an empty list is the good
 * morning, so it gets a sheet and an icon rather than a blank space under the
 * title that reads as a screen that did not load.
 */
export function EmptyState({
  icon,
  children,
}: {
  /** A rendered icon, decorative: the sentence says it. */
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="bg-card flex flex-col items-center gap-3 rounded-lg border px-6 py-10 text-center">
      <span className="bg-muted text-muted-foreground inline-flex size-10 items-center justify-center rounded-full [&_svg]:size-5">
        {icon}
      </span>
      <p className="text-muted-foreground max-w-md text-sm">{children}</p>
    </div>
  );
}
