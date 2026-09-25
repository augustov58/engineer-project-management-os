'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * One item in the app shell's nav, which knows whether it is the screen you are
 * on (ADR-0069 D2, issue #171). The old header had no active state at all.
 *
 * A client component for one reason: the root layout is not re-rendered on a
 * client navigation and is never handed the path, so the path is read here.
 * `usePathname` answers during the server render as well, so the first paint
 * already marks the right item — ADR-0028's rule holds without a ref.
 *
 * `exact` is for `/`, which every path would otherwise start with. Anything
 * else is active on its own path and below it, so a job stays marked on its
 * activity and memory screens.
 */
export function NavLink({
  href,
  icon,
  exact = false,
  children,
}: {
  href: string;
  /** A rendered icon: an element crosses the server boundary, a component does not. */
  icon?: ReactNode;
  exact?: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const active = exact
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors [&_svg]:size-4 [&_svg]:shrink-0',
        active
          ? // `/12` in dark and not the legend's `/20`: this sits on every
            // screen, and blue ink on a `/20` blue read 4.96:1 on the dark sheet.
            'bg-info/10 text-primary font-medium dark:bg-info/12'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {icon}
      {children}
    </Link>
  );
}
