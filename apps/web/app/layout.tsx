import { Geist, Geist_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { currentUser, listProjects, type Theme } from './api';
import { AppShell } from './app-shell';
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
  // The live jobs the sidebar lists (ADR-0069 D2, issue #171). Nobody signed
  // in is shown no nav, so nothing is asked for them.
  const jobs = user === undefined ? [] : await listProjects();

  return (
    <html
      lang="en"
      className={cn('font-sans', geist.variable, geistMono.variable, themeClass(user?.theme))}
    >
      <body className="bg-background text-foreground min-h-svh antialiased">
        <AppShell user={user} jobs={jobs} />
        {/*
          The sidebar is fixed, so the content steps right of it at the width it
          is shown at. `<main>` keeps the desk measure; a record screen still
          applies its own (web.md's measure rule).
        */}
        <div className={user === undefined ? undefined : 'lg:pl-64'}>
          <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
