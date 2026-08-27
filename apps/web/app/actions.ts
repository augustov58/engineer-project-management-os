'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
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
 * The state every "add one of these" form shares — an open item, a phase, a
 * submission.
 *
 * `added` counts successful adds. The form keys off it so that a success
 * remounts every control, which is the only way an uncontrolled field resets:
 * React would otherwise leave the nobody checkbox ticked while clearing the
 * fields around it, silently giving the next item no one to chase.
 *
 * On a rejection `added` does not move, so nothing the author typed is lost,
 * and `error` carries the API's own message rather than a paraphrase.
 */
export interface AddState {
  added: number;
  error?: string;
}

/** The open item fields, read the same way wherever one is raised. */
function openItemPayload(formData: FormData): Record<string, unknown> {
  const sinceDate = omitIfBlank(formData, 'waitingSince');
  return {
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
  };
}

/** The API's own message on refusal, or undefined when it accepted. */
async function refusal(
  response: Response,
  accepted: number,
): Promise<string | undefined> {
  if (response.status === accepted) {
    return undefined;
  }
  const body = (await response.json().catch(() => ({}))) as {
    message?: string;
  };
  return body.message ?? `the API returned ${response.status}`;
}

function send(path: string, body?: unknown): Promise<Response> {
  return fetch(apiPath(path), {
    method: 'POST',
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
}

/**
 * A write with nowhere to show a message. The API's refusals are real
 * outcomes, not noise: swallowing one leaves the screen re-rendered with the
 * old value and the engineer believing the change landed.
 *
 * 409 is tolerated only where it means "already in that state" — the second
 * half of a double click, where the re-render shows what is actually true.
 */
async function sendOrThrow(
  path: string,
  body?: unknown,
  options: { tolerateConflict?: boolean } = {},
): Promise<void> {
  const response = await send(path, body);
  if (response.ok) {
    return;
  }
  if (response.status === 409 && options.tolerateConflict === true) {
    return;
  }

  const problem = (await response.json().catch(() => ({}))) as {
    message?: string;
  };
  throw new Error(
    problem.message ?? `POST ${apiPath(path)} returned ${response.status}`,
  );
}

export async function createOpenItem(
  projectId: string,
  previous: AddState,
  formData: FormData,
): Promise<AddState> {
  const error = await refusal(
    await send(`/projects/${projectId}/open-items`, openItemPayload(formData)),
    201,
  );
  if (error !== undefined) {
    return { added: previous.added, error };
  }

  revalidateOpenItems(projectId);
  return { added: previous.added + 1 };
}

/**
 * An open item raised while looking at an issuance. It is attached to the
 * submission and still lives on the project, so it does not disappear from
 * the project screen the moment it is tied to a set (ADR-0026).
 */
export async function createOpenItemOnSubmission(
  submissionId: string,
  projectId: string,
  previous: AddState,
  formData: FormData,
): Promise<AddState> {
  const error = await refusal(
    await send(`/submissions/${submissionId}/open-items`, openItemPayload(formData)),
    201,
  );
  if (error !== undefined) {
    return { added: previous.added, error };
  }

  revalidateSubmission(submissionId, projectId);
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

  await sendOrThrow(
    `/open-items/${id}/resolve`,
    {
      note: formData.get('note'),
      ...(on === undefined ? {} : { resolvedAt: `${on}T00:00:00.000Z` }),
    },
    { tolerateConflict: true },
  );
  revalidateOpenItems(projectId);
}

export async function reopenOpenItem(
  projectId: string,
  id: string,
): Promise<void> {
  await sendOrThrow(`/open-items/${id}/reopen`, undefined, {
    tolerateConflict: true,
  });
  revalidateOpenItems(projectId);
}

/** Every screen an open item appears on. */
function revalidateOpenItems(projectId: string): void {
  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/pending');
  // An item resolving changes what every submission resting on it shows.
  revalidatePath('/submissions/[id]', 'page');
}


// ── Phases ────────────────────────────────────────────────────────────────

export async function createPhase(
  projectId: string,
  previous: AddState,
  formData: FormData,
): Promise<AddState> {
  const error = await refusal(
    await send(`/projects/${projectId}/phases`, { name: formData.get('name') }),
    201,
  );
  if (error !== undefined) {
    return { added: previous.added, error };
  }

  revalidatePath(`/projects/${projectId}`);
  return { added: previous.added + 1 };
}

/**
 * A refused rename — the name is already on this project — is an ordinary
 * mistake, so it comes back as a message beside the field rather than as an
 * error page. `added` counts accepted renames and remounts the field.
 */
export async function renamePhase(
  projectId: string,
  phaseId: string,
  previous: AddState,
  formData: FormData,
): Promise<AddState> {
  const error = await refusal(
    await send(`/phases/${phaseId}/rename`, { name: formData.get('name') }),
    200,
  );
  if (error !== undefined) {
    return { added: previous.added, error };
  }

  revalidatePath(`/projects/${projectId}`);
  // A rename propagates to every submission issued at this phase (ADR-0026),
  // so those screens are stale too.
  revalidatePath('/submissions/[id]', 'page');
  return { added: previous.added + 1 };
}

/** The whole ordered list, because that is what the API takes (ADR-0026). */
export async function reorderPhases(
  projectId: string,
  phaseIds: string[],
): Promise<void> {
  await sendOrThrow(`/projects/${projectId}/phases/order`, { phaseIds });
  revalidatePath(`/projects/${projectId}`);
}

export async function setCurrentPhase(
  projectId: string,
  phaseId: string,
): Promise<void> {
  await sendOrThrow(`/projects/${projectId}/current-phase`, { phaseId });
  revalidatePath(`/projects/${projectId}`);
}

// ── Submissions ───────────────────────────────────────────────────────────

/** The submission fields, read the same way wherever a set is issued. */
function submissionPayload(formData: FormData): Record<string, unknown> {
  const issued = omitIfBlank(formData, 'issuedAt');
  return {
    phaseId: formData.get('phaseId'),
    // A date input gives a day; the record keeps an instant.
    issuedAt: issued === undefined ? undefined : `${issued}T00:00:00.000Z`,
    recipient: formData.get('recipient'),
    recipientRole: formData.get('recipientRole'),
    revision: formData.get('revision'),
    sheetList: formData.get('sheetList'),
    // Repeated checkbox name: what the set rests on is named while the
    // issuance is recorded, so issue #6 has a moment at which both the row
    // and its open items exist to stamp against.
    //
    // Always sent, including empty. On a reissue that is the point: the API
    // carries the superseded set's items forward when the field is absent, so
    // an engineer who unticks every box has to be able to say so.
    openItemIds: formData.getAll('openItemIds'),
  };
}

export async function createSubmission(
  projectId: string,
  previous: AddState,
  formData: FormData,
): Promise<AddState> {
  const error = await refusal(
    await send(`/projects/${projectId}/submissions`, submissionPayload(formData)),
    201,
  );
  if (error !== undefined) {
    return { added: previous.added, error };
  }

  revalidatePath(`/projects/${projectId}`);
  return { added: previous.added + 1 };
}

/**
 * Reissue: a correction is a new submission pointing at this one, never an
 * edit of it (ADR-0015). On success the engineer lands on the record that is
 * now current, because that is the one they went on to work from.
 */
export async function reissueSubmission(
  submissionId: string,
  projectId: string,
  previous: AddState,
  formData: FormData,
): Promise<AddState> {
  const response = await send(
    `/submissions/${submissionId}/reissue`,
    submissionPayload(formData),
  );
  const error = await refusal(response, 201);
  if (error !== undefined) {
    return { added: previous.added, error };
  }

  const reissued = (await response.json()) as { id: string };
  revalidatePath(`/projects/${projectId}`);
  // The superseded record now reads as superseded, and exposure counts the
  // successor rather than it.
  revalidatePath(`/submissions/${submissionId}`);
  revalidatePath('/exposure');
  redirect(`/submissions/${reissued.id}`);
}

export async function attachOpenItem(
  submissionId: string,
  projectId: string,
  formData: FormData,
): Promise<void> {
  const openItemId = formData.get('openItemId');
  if (openItemId === null || openItemId === '') {
    return;
  }

  await sendOrThrow(
    `/submissions/${submissionId}/open-items/${openItemId}`,
    undefined,
    // Already on this set is the second half of a double click; the
    // re-render shows what is actually true.
    { tolerateConflict: true },
  );
  revalidateSubmission(submissionId, projectId);
}

export async function detachOpenItem(
  submissionId: string,
  projectId: string,
  openItemId: string,
): Promise<void> {
  const path = `/submissions/${submissionId}/open-items/${openItemId}`;
  const response = await fetch(apiPath(path), { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    throw new Error(`DELETE ${apiPath(path)} returned ${response.status}`);
  }

  revalidateSubmission(submissionId, projectId);
}

/** Both screens a submission's open items appear on. */
function revalidateSubmission(submissionId: string, projectId: string): void {
  revalidatePath(`/submissions/${submissionId}`);
  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/pending');
}

// ── Assumption records ────────────────────────────────────────────────────

/**
 * Capturing what a helper skill produced. The blocks are pasted, never
 * retyped, and nothing here trims them — "verbatim" is the whole point, so
 * `omitIfBlank`'s trim is deliberately not used on either.
 */
export async function captureAssumptionRecord(
  submissionId: string,
  projectId: string,
  previous: AddState,
  formData: FormData,
): Promise<AddState> {
  const on = omitIfBlank(formData, 'calculatedAt');
  const error = await refusal(
    await send(`/submissions/${submissionId}/assumption-records`, {
      assumptions: formData.get('assumptions'),
      flags: formData.get('flags'),
      codeEdition: formData.get('codeEdition'),
      // A date input gives a day; the record keeps an instant.
      calculatedAt: on === undefined ? undefined : `${on}T00:00:00.000Z`,
    }),
    201,
  );
  if (error !== undefined) {
    return { added: previous.added, error };
  }

  revalidatePath(`/submissions/${submissionId}`);
  revalidatePath(`/projects/${projectId}`);
  return { added: previous.added + 1 };
}

/** What changes if one assumed input turns out wrong, against its own line. */
export async function writeCounterfactual(
  recordId: string,
  line: number,
  submissionId: string,
  previous: AddState,
  formData: FormData,
): Promise<AddState> {
  const error = await refusal(
    await send(
      `/assumption-records/${recordId}/assumptions/${line}/counterfactual`,
      { counterfactual: formData.get('counterfactual') },
    ),
    201,
  );
  if (error !== undefined) {
    return { added: previous.added, error };
  }

  revalidatePath(`/submissions/${submissionId}`);
  return { added: previous.added + 1 };
}

/**
 * A flag raised as an open item. `unresolved` is left off, so the flag's own
 * wording is what lands on the item — nothing is transcribed by hand.
 */
export async function raiseFlag(
  recordId: string,
  line: number,
  submissionId: string,
  projectId: string,
  previous: AddState,
  formData: FormData,
): Promise<AddState> {
  const { unresolved, ...payload } = openItemPayload(formData);
  const error = await refusal(
    await send(
      `/assumption-records/${recordId}/flags/${line}/open-item`,
      // Supplied only where the engineer overrode the flag's own wording.
      unresolved === '' || unresolved === null
        ? payload
        : { ...payload, unresolved },
    ),
    201,
  );
  if (error !== undefined) {
    return { added: previous.added, error };
  }

  revalidateSubmission(submissionId, projectId);
  return { added: previous.added + 1 };
}
