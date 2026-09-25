import { Geist, Geist_Mono } from 'next/font/google';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { currentUser, type Theme } from './api';
import { signOut } from './sign-in/actions';
import { ThemeForm } from './theme-form';
import './globals.css';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });
// Identifiers only — a job number, an entry number, a filename (ADR-0069,
// issue #169). Until now `font-mono` fell back to whatever the system had.
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' });

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
      className={cn('font-sans', geist.variable, geistMono.variable, themeClass(user?.theme))}
    >
      <body className="bg-background text-foreground min-h-svh antialiased">
        <header className="border-b">
          {/*
            **It wraps** (issue #120, density rule 7: *one column below 768 px,
            everywhere, including the desk screens*). Neither row carried
            `flex-wrap` until now, so the nav's min-content width — the brand,
            five links, the theme control and the sign-out — was **735 px**, and
            a non-wrapping flex inside `<body>` propagates that to the document:
            at 390 px the whole page scrolled sideways, the walk screen
            included, though the walk's own content was 390 px. It predates
            issue #118, which changed no part of the shell.

            Wrapping and not `overflow-x-auto`, which is what the walk's jumper
            does: the jumper is five anchors that have to stay one 44 px bar, and
            this is a header that may be two rows on a phone and costs nothing
            by being one.
          */}
          <nav className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
            <Link href="/" className="text-sm font-semibold tracking-tight">
              Engineer PM OS
            </Link>
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
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
            {/*
              Keyword search across every job (issue #66, ADR-0067): a native
              GET form, so it submits with no script and a search is a URL to
              bookmark or send, like the scope toggle's two links.
            */}
            <form action="/search" role="search" className="min-w-0">
              <input
                type="search"
                name="q"
                maxLength={200}
                aria-label="Search every job"
                placeholder="Search every job"
                className="border-input bg-background h-8 w-44 min-w-0 rounded-md border px-2 text-sm"
              />
            </form>
            {user !== undefined && (
              <div className="ml-auto flex flex-wrap items-center gap-2">
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
