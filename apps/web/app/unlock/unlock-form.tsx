'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { unlock } from './actions';

export function UnlockForm({ next }: { next: string }) {
  const [error, action, pending] = useActionState<string | undefined, FormData>(
    unlock,
    undefined,
  );

  return (
    <div className="space-y-3">
      <form action={action} className="flex flex-wrap gap-2">
        <input type="hidden" name="next" value={next} />
        <Input
          name="secret"
          type="password"
          required
          autoFocus
          autoComplete="current-password"
          placeholder="The shared secret"
          aria-label="The shared secret"
          className="min-w-64 flex-1"
        />
        <Button type="submit" disabled={pending}>
          Unlock
        </Button>
      </form>
      {error !== undefined && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
