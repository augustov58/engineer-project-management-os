'use client';

import { Menu } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';

/**
 * The shell's nav below 1024 px, behind one button (ADR-0069 D2, issue #171).
 *
 * A native `<details>`, like every disclosure in this product, so it opens
 * with no script. The script is only for closing: the root layout stays
 * mounted across a client navigation, so an open `<details>` would still be
 * open over the next screen. Closing on a path change is all the effect does;
 * the first paint is closed, which is what the server renders.
 */
export function PhoneMenu({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const menu = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (menu.current !== null) menu.current.open = false;
  }, [pathname]);

  return (
    <details ref={menu} className="group">
      <summary className="bg-card hover:bg-muted flex h-11 cursor-pointer list-none items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors [&::-webkit-details-marker]:hidden">
        <Menu aria-hidden className="size-4" />
        Menu
      </summary>
      {/* Every target in it is 44 px: this is the menu a thumb opens on the walk. */}
      <div className="bg-card absolute inset-x-4 top-14 z-40 max-h-[calc(100svh-4.5rem)] overflow-y-auto rounded-lg border p-2 shadow-lg [&_a]:min-h-11 [&_button]:min-h-11 [&_button]:min-w-11">
        {children}
      </div>
    </details>
  );
}
