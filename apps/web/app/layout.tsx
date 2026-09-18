import { Geist } from 'next/font/google';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { currentUser, type Theme } from './api';
import { signOut } from './sign-in/actions';
import { ThemeForm } from './theme-form';
import './globals.css';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });

/**
 * The class `<html>` carries for a theme (issue #117, ADR-0059 point 4 as the
 * design brief's decision 2 extends it).
 *
 * *System* is **no class at all** — it is the absence of an override, which
 * leaves `color-scheme: light dark` in `globals.css` to let
 * `prefers-color-scheme` answer. Signed in as nobody is the same case.
 *
 * Written by the server and never by a client hook: this layout reads the
 * session on every request already, so the theme is known before the first
 * byte. That is the whole reason it is a column and not a cookie read in the
 * browser — there is no flash of the other theme and no hydration mismatch to
 * suppress.
 */
function themeClass(theme: Theme | undefined): string | undefined {
  switch (theme) {
    case 'LIGHT':
      return 'light';
    case 'DARK':
      return 'dark';
    default:
      return undefined;
  }
}

export const metadata = {
  title: 'Engineer Project Management OS',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  /**
   * Who is signed in, or nobody — which is what the sign-in screen renders,
   * since this header is above it too (issue #105). The read answers rather
   * than redirecting for exactly that reason: a redirect here would send the
   * sign-in screen to the sign-in screen.
   */
  const user = await currentUser();

  return (
    <html
      lang="en"
      className={cn('font-sans', geist.variable, themeClass(user?.theme))}
    >
      <body className="bg-background text-foreground min-h-svh antialiased">
        <header className="border-b">
          <nav className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-3">
            <Link href="/" className="text-sm font-semibold tracking-tight">
              Engineer PM OS
            </Link>
            <div className="text-muted-foreground flex items-center gap-4 text-sm">
              {/*
                `/` is the morning screen (story 47), and the project list is
                the section under its two counts — so the nav says what the
                landing view is rather than naming one section of it.
              */}
              <Link href="/" className="hover:text-foreground transition-colors">
                This morning
              </Link>
              <Link
                href="/pending"
                className="hover:text-foreground transition-colors"
              >
                Pending items
              </Link>
              <Link
                href="/exposure"
                className="hover:text-foreground transition-colors"
              >
                Exposure
              </Link>
              <Link
                href="/clock"
                className="hover:text-foreground transition-colors"
              >
                Clock
              </Link>
              <Link
                href="/users"
                className="hover:text-foreground transition-colors"
              >
                People
              </Link>
            </div>
            {user !== undefined && (
              <div className="ml-auto flex items-center gap-3">
                {/*
                  The theme is the signed-in person's, so the control is here
                  and not above the sign-in screen: with nobody signed in there
                  is nothing to store a choice on, and the system's preference
                  is the answer (issue #117).
                */}
                <ThemeForm theme={user.theme} />
                <form action={signOut} className="flex items-center gap-3">
                  <span className="text-muted-foreground text-sm">
                    {user.name}
                  </span>
                  <button
                    type="submit"
                    className="text-muted-foreground hover:text-foreground text-sm transition-colors"
                  >
                    Sign out
                  </button>
                </form>
              </div>
            )}
          </nav>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
