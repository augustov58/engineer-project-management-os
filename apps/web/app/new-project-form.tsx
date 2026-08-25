'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createProject } from './actions';

export function NewProjectForm() {
  const [error, action, pending] = useActionState(createProject, undefined);

  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="projectNumber">Project number</Label>
        <Input
          id="projectNumber"
          name="projectNumber"
          required
          placeholder="T-1"
          className="w-28 font-mono"
        />
      </div>

      <div className="grid flex-1 gap-1.5">
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" required className="min-w-48" />
      </div>

      <Button type="submit" disabled={pending}>
        Add project
      </Button>

      {error !== undefined && (
        <p role="alert" className="text-destructive w-full text-sm">
          {error}
        </p>
      )}
    </form>
  );
}
