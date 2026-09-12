'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { signIn } from './actions';

export function SignInForm({ next }: { next: string }) {
  const [error, action, pending] = useActionState<string | undefined, FormData>(
    signIn,
    undefined,
  );

  return (
    <div className="space-y-3">
      <form action={action} className="space-y-2">
        <input type="hidden" name="next" value={next} />
        <Input
          name="email"
          type="email"
          required
          autoFocus
          autoComplete="username"
          placeholder="you@example.com"
          aria-label="Email"
        />
        <Input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          placeholder="Password"
          aria-label="Password"
        />
        <Button type="submit" disabled={pending}>
          Sign in
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
