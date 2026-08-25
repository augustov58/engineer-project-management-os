'use client';

import { useActionState } from 'react';
import { createProject } from './actions';

export function NewProjectForm() {
  const [error, action, pending] = useActionState(createProject, undefined);

  return (
    <form action={action}>
      <label>
        Project number{' '}
        <input name="projectNumber" required placeholder="T-1" size={8} />
      </label>{' '}
      <label>
        Name <input name="name" required size={32} />
      </label>{' '}
      <button type="submit" disabled={pending}>
        Add project
      </button>
      {error !== undefined && <p role="alert">{error}</p>}
    </form>
  );
}
