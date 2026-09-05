'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * The Extract control and the API's answer to it (issue #67).
 *
 * A button in a list row, not a form, so until now the ask had nowhere to put
 * a message and threw on every refusal but the double click. On a job on
 * local processing the refusal is ADR-0044's gate firing as designed, and it
 * arrived as Next's error screen — a gate that refuses correctly and looks
 * like a crash is one the engineer learns to distrust.
 *
 * The button stays rendered on a local job rather than being hidden. The API
 * is this product's only validator, and a screen that hid the control would
 * be deciding the gate's predicate for itself; a page left open while the
 * setting changed underneath it would show the button regardless, with
 * nothing to say why it failed. Rendered and answered, the sentence is the
 * API's own on both paths, and it says what the gate is for.
 */
export function ExtractButton({
  request,
}: {
  request: (previous: string | undefined) => Promise<string | undefined>;
}) {
  const [error, action, pending] = useActionState(request, undefined);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        Extract
      </Button>
      {error !== undefined && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </form>
  );
}
