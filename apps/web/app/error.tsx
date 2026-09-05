'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';

/**
 * Where an unhandled throw lands (issue #67).
 *
 * Until this file existed `apps/web` had no error boundary at all, so any
 * action the code did not expect to fail reached the framework and the
 * engineer got Next's default screen. This one says what happened in the
 * product's own words and offers the two ways back: rendering this segment
 * again, and the morning screen.
 *
 * In production Next replaces a server-side message with a generic sentence
 * and a digest that matches the server log, so the copy does not promise a
 * reason — it shows whatever it was given and the digest when there is one.
 */
export default function ErrorScreen({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div className="space-y-4 rounded-lg border p-6">
      <h1 className="text-lg font-medium">This page could not finish</h1>
      <p className="text-muted-foreground text-sm">
        Something threw that nothing was written to catch. What the page shows
        may be behind what the record holds; trying again renders it afresh.
      </p>
      <p role="alert" className="text-destructive text-sm">
        {error.message}
      </p>
      {error.digest !== undefined && (
        <p className="text-muted-foreground font-mono text-xs">
          digest {error.digest}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" onClick={() => retry()}>
          Try again
        </Button>
        <Link
          href="/"
          className="text-muted-foreground hover:text-foreground text-sm underline underline-offset-4 transition-colors"
        >
          This morning
        </Link>
      </div>
    </div>
  );
}
