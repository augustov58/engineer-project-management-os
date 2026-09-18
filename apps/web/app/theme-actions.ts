'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch, apiPath } from './api';

/**
 * Set the signed-in person's theme (issue #117).
 *
 * The route carries no id — a theme is the caller's own, and the API reads who
 * off the session. `revalidatePath('/', 'layout')` and not the current path:
 * the class this changes is written on `<html>` by the root layout, so it is
 * the layout's render that has to be thrown away rather than the screen's.
 */
export async function setTheme(formData: FormData): Promise<void> {
  const path = '/users/current/theme';
  const response = await apiFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ theme: formData.get('theme') }),
  });
  if (!response.ok) {
    throw new Error(`POST ${apiPath(path)} returned ${response.status}`);
  }
  revalidatePath('/', 'layout');
}
