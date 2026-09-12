'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch, apiPath } from '../api';

/**
 * The API is the only validator. Its message is shown as-is rather than
 * re-checked here, so the browser and any other client see the same rules.
 */
export async function addUser(
  _previous: string | undefined,
  formData: FormData,
): Promise<string | undefined> {
  const response = await apiFetch('/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: formData.get('name'),
      email: formData.get('email'),
      password: formData.get('password'),
    }),
  });

  if (response.status !== 201) {
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    return body.message ?? `the API returned ${response.status}`;
  }

  revalidatePath('/users');
  return undefined;
}

export async function disableUser(id: string): Promise<void> {
  const path = `/users/${id}/disable`;
  const response = await apiFetch(path, { method: 'POST' });
  if (!response.ok) {
    throw new Error(`POST ${apiPath(path)} returned ${response.status}`);
  }
  revalidatePath('/users');
}
