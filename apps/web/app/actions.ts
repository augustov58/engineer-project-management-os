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

/** Empty optional fields are omitted rather than sent blank. */
function omitIfBlank(formData: FormData, field: string): string | undefined {
  const value = String(formData.get(field) ?? '').trim();
  return value === '' ? undefined : value;
}

/**
 * `added` counts successful adds. The form keys off it so that a success
 * remounts every control — including the nobody checkbox, which React would
 * otherwise leave ticked while it resets the uncontrolled fields around it,
 * silently giving the next item no one to chase.
 *
 * On a rejection `added` does not move, so nothing the author typed is lost.
 */
export interface AddOpenItemState {
  added: number;
  error?: string;
}

export async function createOpenItem(
  projectId: string,
  previous: AddOpenItemState,
  formData: FormData,
): Promise<AddOpenItemState> {
  const sinceDate = omitIfBlank(formData, 'waitingSince');

  const response = await fetch(
    apiPath(`/projects/${projectId}/open-items`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        unresolved: formData.get('unresolved'),
        blocks: formData.get('blocks'),
        // The checkbox is the only way to say nobody. Leaving the party blank
        // sends a blank, which the API refuses — an empty field is not an
        // answer to who owes the next move.
        waitingOn:
          formData.get('nobody') === null
            ? String(formData.get('waitingOn') ?? '').trim()
            : null,
        // A date input gives a day; the record keeps an instant.
        waitingSince:
          sinceDate === undefined ? undefined : `${sinceDate}T00:00:00.000Z`,
        invalidationTrigger: omitIfBlank(formData, 'invalidationTrigger'),
        counterfactual: formData.get('counterfactual'),
        owner: omitIfBlank(formData, 'owner'),
      }),
    },
  );

  if (response.status !== 201) {
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    return {
      added: previous.added,
      error: body.message ?? `the API returned ${response.status}`,
    };
  }

  revalidateOpenItems(projectId);
  return { added: previous.added + 1 };
}

export async function resolveOpenItem(
  projectId: string,
  id: string,
  formData: FormData,
): Promise<void> {
  // An item answered in April must not read as answered today just because
  // that is when it was typed in.
  const on = omitIfBlank(formData, 'resolvedAt');

  await post(`/open-items/${id}/resolve`, {
    note: formData.get('note'),
    ...(on === undefined ? {} : { resolvedAt: `${on}T00:00:00.000Z` }),
  });
  revalidateOpenItems(projectId);
}

export async function reopenOpenItem(
  projectId: string,
  id: string,
): Promise<void> {
  await post(`/open-items/${id}/reopen`);
  revalidateOpenItems(projectId);
}

async function post(path: string, body?: unknown): Promise<void> {
  const response = await fetch(apiPath(path), {
    method: 'POST',
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  // 409 is "already in that state" — the second half of a double click. The
  // re-render below shows what is actually true, which is what the author
  // wanted; an error page would not be.
  if (!response.ok && response.status !== 409) {
    throw new Error(`POST ${apiPath(path)} returned ${response.status}`);
  }
}

/** Both screens an open item appears on. */
function revalidateOpenItems(projectId: string): void {
  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/pending');
}
