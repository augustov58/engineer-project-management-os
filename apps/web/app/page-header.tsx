import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * A screen's head: where it sits, its title, one line about it, and what can
 * be done from it (ADR-0069, the plan's `PageHeader`; issue #173).
 *
 * The *Title* step of the brief's type scale, one size up at the desk. The
 * `aside` is the screen's own control — the mine/ours toggle on the daily
 * layer — and sits at the end of the title row, dropping under it on a phone.
 */
export function PageHeader({
  back,
  title,
  description,
  aside,
}: {
  /** The job this screen is one reading of, where it is. */
  back?: { href: string; label: ReactNode };
  title: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="space-y-2">
      {back !== undefined && (
        <Link
          href={back.href}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm transition-colors"
        >
          <ArrowLeft aria-hidden className="size-4" />
          {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight lg:text-[28px] lg:leading-[34px]">
            {title}
          </h1>
          {description !== undefined && (
            <p className="text-muted-foreground mt-1 text-sm">{description}</p>
          )}
        </div>
        {aside}
      </div>
    </div>
  );
}
