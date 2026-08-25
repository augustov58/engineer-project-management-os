'use server';

import { revalidatePath } from 'next/cache';
import { apiPath } from './api';

/**
 * The API is the only validator. Its message is shown as-is rather than
 * re-checked here, so the browser and any other client see the same rules.
 */
export async function createProject(
  _previous: string | undefined,
  formData: FormData,
): Promise<string | undefined> {
  const response = await fetch(apiPath('/projects'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectNumber: formData.get('projectNumber'),
      name: formData.get('name'),
    }),
  });

  if (response.status !== 201) {
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    return body.message ?? `the API returned ${response.status}`;
  }

  revalidatePath('/');
  return undefined;
}

export async function archiveProject(id: string): Promise<void> {
  const path = `/projects/${id}/archive`;
  const response = await fetch(apiPath(path), { method: 'POST' });
  if (!response.ok) {
    throw new Error(`POST ${apiPath(path)} returned ${response.status}`);
  }

  revalidatePath('/');
  revalidatePath(`/projects/${id}`);
}
