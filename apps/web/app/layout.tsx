import { Geist } from 'next/font/google';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import './globals.css';

const geist = Geist({ subsets: ['latin'], variable: '--font-sans' });

export const metadata = {
  title: 'Engineer Project Management OS',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={cn('font-sans', geist.variable)}>
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
            </div>
          </nav>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
