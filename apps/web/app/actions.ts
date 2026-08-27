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
 *
 * `tolerated` names that one message rather than tolerating every 409, because
 * a route can refuse for more than one reason: ending a visit answers both
 * "already ended" and "cannot end before it started", and swallowing the
 * second would turn the button into a silent no-op.
 */
async function sendOrThrow(
  path: string,
  body?: unknown,
  options: { tolerateConflict?: boolean; tolerated?: string } = {},
): Promise<void> {
  const response = await send(path, body);
  if (response.ok) {
    return;
  }

  const problem = (await response.json().catch(() => ({}))) as {
    message?: string;
  };
  if (response.status === 409) {
    if (options.tolerateConflict === true) {
      return;
    }
    if (options.tolerated !== undefined && problem.message === options.tolerated) {
      return;
    }
  }

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
 * A textarea's own newlines, not the browser's.
 *
 * HTML's "create an entry" algorithm normalises every newline in a form entry
 * to CRLF, so a block pasted from a terminal — LF, like everything the helper
 * skills print — arrives here with a `\r` ending every line and would store as
 * something other than what was captured, leaving a stray carriage return on
 * each split line. Undone at the boundary that introduced it rather than in
 * the API, which keeps byte-for-byte whatever it is handed and must go on
 * doing so for a caller that means CRLF.
 *
 * Found by capturing a record through the form and reading the bytes back —
 * invisible to `pnpm typecheck`, to `pnpm test`, and on the screen.
 */
function pasted(formData: FormData, field: string): string {
  return String(formData.get(field) ?? '').replace(/\r\n/g, '\n');
}

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
      assumptions: pasted(formData, 'assumptions'),
      flags: pasted(formData, 'flags'),
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
 * A flag raised as an open item.
 *
 * The form arrives with `unresolved` already filled from the flag, so that is
 * what is sent and nothing is transcribed by hand — the engineer may still
 * reword a terse flag before committing. The API's own fallback, for a caller
 * that omits the field entirely, is the same flag text; this keeps the two
 * from disagreeing by sending nothing when the field comes back empty.
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

// ── Site visits and observations ──────────────────────────────────────────

/**
 * A date input gives a day and a time input gives a clock time; the record
 * keeps an instant, composed from both.
 *
 * Undefined unless **both** are present, so the API's own fallback — the
 * injected clock — applies to the whole stamp or to none of it. Composing a
 * day against a missing time would silently stamp midnight, and a time against
 * a missing day would silently discard what the engineer typed; each screen
 * therefore either supplies a day or requires one, so "the time was ignored"
 * is not a state this can reach.
 *
 * The clock time is written as though it were UTC, which is the convention
 * every other date in this product already follows (`T00:00:00.000Z`). It is
 * self-consistent for anything typed and wrong against anything the injected
 * clock stamped — see the note in the README; it is a product-wide decision
 * and not this slice's to take.
 */
function composeInstant(
  formData: FormData,
  dayField: string,
  timeField: string,
): string | undefined {
  const day = omitIfBlank(formData, dayField);
  const time = omitIfBlank(formData, timeField);
  if (day === undefined || time === undefined) {
    return undefined;
  }
  return `${day}T${time}:00.000Z`;
}

/**
 * Recording a walk. The end may be left off — the per-floor schedule is
 * recorded during the visit, so a walk exists before it is over.
 */
export async function createSiteVisit(
  projectId: string,
  previous: AddState,
  formData: FormData,
): Promise<AddState> {
  const error = await refusal(
    await send(`/projects/${projectId}/site-visits`, {
      // Both required by the form, so this is always the pair that was typed.
      startedAt: composeInstant(formData, 'visitedOn', 'startedAt'),
      // Left off while the walk is still under way, which is the whole reason
      // `ended_at` is nullable.
      endedAt: composeInstant(formData, 'visitedOn', 'endedAt'),
    }),
    201,
  );
  if (error !== undefined) {
    return { added: previous.added, error };
  }

  revalidatePath(`/projects/${projectId}`);
  return { added: previous.added + 1 };
}

export async function endSiteVisit(
  siteVisitId: string,
  projectId: string,
): Promise<void> {
  // Already ended is the second half of a double tap; the re-render shows what
  // is actually true. Every other refusal this route makes still surfaces.
  await sendOrThrow(
    `/site-visits/${siteVisitId}/end`,
    {},
    { tolerated: 'that site visit has already ended' },
  );
  revalidateSiteVisit(siteVisitId, projectId);
}

/**
 * Arriving on a floor. A refusal — this floor is already on the schedule — is
 * an ordinary mistake and comes back beside the field rather than as an error
 * page.
 */
export async function startFloor(
  siteVisitId: string,
  visitedOn: string,
  projectId: string,
  previous: AddState,
  formData: FormData,
): Promise<AddState> {
  const error = await refusal(
    await send(`/site-visits/${siteVisitId}/floors`, {
      floor: formData.get('floor'),
      // The day is the visit's; only the clock time is asked for. A walk
      // entered after the fact must be able to carry its real floor times,
      // because that pair is the window issue #11 bins photographs against.
      startedAt: composeInstant(
        withDay(formData, visitedOn),
        'day',
        'startedAt',
      ),
    }),
    201,
  );
  if (error !== undefined) {
    return { added: previous.added, error };
  }

  revalidateSiteVisit(siteVisitId, projectId);
  return { added: previous.added + 1 };
}

export async function completeFloor(
  floorId: string,
  siteVisitId: string,
  visitedOn: string,
  projectId: string,
  formData: FormData,
): Promise<void> {
  await sendOrThrow(
    `/site-visit-floors/${floorId}/complete`,
    {
      completedAt: composeInstant(
        withDay(formData, visitedOn),
        'day',
        'completedAt',
      ),
    },
    // Already completed is the second half of a double tap. "Before it was
    // started" is not, and still surfaces.
    { tolerated: 'that floor is already completed' },
  );
  revalidateSiteVisit(siteVisitId, projectId);
}

/**
 * Recording an observation. It stays an observation: nothing here promotes
 * one to a finding, because the non-issues table is the majority case.
 *
 * Exactly one of side or sector is sent. The form makes them one control, so
 * the axis and its value arrive together and the grammar cannot be corrupted
 * by the interface.
 */
export async function recordObservation(
  siteVisitId: string,
  visitedOn: string,
  projectId: string,
  previous: AddState,
  formData: FormData,
): Promise<AddState> {
  const axis = String(formData.get('axis') ?? 'side');
  const value = omitIfBlank(formData, 'axisValue');

  const error = await refusal(
    await send(`/site-visits/${siteVisitId}/observations`, {
      observed: formData.get('observed'),
      // The day is the visit's, so only a clock time is asked for on the
      // screen and a typed one can never be dropped for want of a date.
      observedAt: composeInstant(
        withDay(formData, visitedOn),
        'day',
        'observedAt',
      ),
      floor: formData.get('floor'),
      qualifier: formData.get('qualifier'),
      // Never both. A blank value is sent as a blank so the API refuses it,
      // rather than being omitted and refused for the wrong reason.
      side: axis === 'side' ? (value ?? '') : undefined,
      sector: axis === 'sector' ? (value ?? '') : undefined,
    }),
    201,
  );
  if (error !== undefined) {
    return { added: previous.added, error };
  }

  revalidateSiteVisit(siteVisitId, projectId);
  return { added: previous.added + 1 };
}

/**
 * The form's fields plus the day they happened on, which is the visit's rather
 * than a field on the screen: everything in a walk happened on the day of the
 * walk, so asking for it again per floor and per observation would be asking
 * the engineer to retype something already recorded.
 */
function withDay(formData: FormData, day: string): FormData {
  const withIt = new FormData();
  for (const [key, value] of formData.entries()) {
    withIt.append(key, value);
  }
  withIt.set('day', day);
  return withIt;
}

/** Both screens a visit appears on. */
function revalidateSiteVisit(siteVisitId: string, projectId: string): void {
  revalidatePath(`/site-visits/${siteVisitId}`);
  revalidatePath(`/projects/${projectId}`);
}
