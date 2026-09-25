import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * One count on the daily layer, as a link to exactly the list it counted
 * (ADR-0069, the plan's `StatTile`; issue #173).
 *
 * **One count, never two**: a tile takes a single number, which is the whole
 * of ADR-0016 as a component — there is nowhere on it to put a second figure
 * or a ratio. The number is the list's length, so the tile and the screen it
 * lands on cannot disagree (bar 5), and it renders **at zero** (web.md's
 * morning-screen rule): a tile that vanished would read as one that had not
 * loaded.
 *
 * Above zero it takes the legend's red, because every count on the daily layer
 * is of something late or unconfirmed; at zero it says so in words and stays
 * neutral. The state is always a word, never colour alone.
 */
export function StatTile({
  href,
  count,
  icon,
  label,
  due,
  destination,
}: {
  href: string;
  count: number;
  /** A rendered icon, decorative. */
  icon: ReactNode;
  /** What the number counts, read after it. */
  label: string;
  /** The word the red badge says when the count is above zero. */
  due: string;
  /** The list it lands on, said on the tile. */
  destination: string;
}) {
  const late = count > 0;
  return (
    <Link
      href={href}
      className="group bg-card hover:bg-muted/40 block rounded-lg border p-5 shadow-xs transition-colors"
    >
      <span className="flex items-start justify-between gap-3">
        <span
          className={cn(
            'inline-flex size-9 items-center justify-center rounded-lg [&_svg]:size-5',
            late
              ? 'bg-destructive/10 text-destructive dark:bg-destructive/20'
              : 'bg-muted text-muted-foreground',
          )}
        >
          {icon}
        </span>
        {late ? (
          <Badge variant="destructive">{due}</Badge>
        ) : (
          <Badge variant="secondary">Nothing waiting</Badge>
        )}
      </span>
      <span
        data-slot="count"
        className="mt-4 block text-[32px] leading-9 font-semibold tabular-nums"
      >
        {count}
      </span>
      <span className="mt-1 block text-sm">{label}</span>
      <span className="text-primary mt-4 flex items-center gap-1 text-sm font-medium">
        {destination}
        <ArrowRight
          aria-hidden
          className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
        />
      </span>
    </Link>
  );
}
