'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { addUser } from './actions';

/**
 * Adding the next account.
 *
 * Any signed-in engineer may, and there is no role that says who: accounts are
 * recorded rather than prevented, and the audit line written beside the row is
 * what records them (ADR-0055).
 */
export function NewUserForm() {
  const [error, action, pending] = useActionState(addUser, undefined);

  return (
    <div className="space-y-2">
      <form action={action} className="flex flex-wrap items-end gap-3">
        <div className="grid flex-1 gap-1.5">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" required className="min-w-40" />
        </div>

        <div className="grid flex-1 gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="off"
            className="min-w-48"
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            className="min-w-44"
          />
        </div>

        <Button type="submit" disabled={pending}>
          Add
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
