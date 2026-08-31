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
  // An item resolving changes what every submission resting on it shows, and
  // what every finding it is being chased for shows.
  revalidatePath('/submissions/[id]', 'page');
  revalidatePath('/projects/[id]/issues/[number]', 'page');
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

/**
 * The type a browser could not name for itself.
 *
 * Desktop Chrome and Firefox report an empty type for a `.heic`, which the API
 * refuses — while the picker offers HEIC, and HEIC is what a walk on an iPhone
 * produces and what the messaging app hands back. The extension is the only
 * other thing that says what the file is, and the four here are exactly the
 * four the API stores.
 */
const TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  webp: 'image/webp',
};

function contentTypeOf(file: File): string {
  if (file.type !== '') {
    return file.type;
  }
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  // Sent as an empty string rather than omitted when nothing is known, so the
  // API refuses it by the same rule as any other bad type.
  return TYPE_BY_EXTENSION[extension] ?? '';
}

/**
 * Adding **one** photograph to a walk (stories 63-65). The API's refusal
 * message, or undefined when it took it.
 *
 * One request per photograph, and pointedly not the whole selection in one:
 * a server action's body is capped, a walk is a hundred photographs of two to
 * four megabytes each, and one body carrying all of them is a request nobody
 * should make. The form calls this in a loop and counts, which also means a
 * refusal names the file it was about.
 *
 * `takenAt` comes from the browser rather than from this file, because
 * `File.lastModified` is the only time a picked file carries and the browser
 * is the only side that knows which wall clock the engineer was reading.
 */
export async function addPhoto(
  siteVisitId: string,
  projectId: string,
  file: File,
  takenAt: string,
): Promise<string | undefined> {
  const refused = await refusal(
    await send(`/site-visits/${siteVisitId}/photos`, {
      filename: file.name,
      takenAt,
      contentType: contentTypeOf(file),
      bytes: Buffer.from(await file.arrayBuffer()).toString('base64'),
    }),
    201,
  );

  revalidatePhoto(siteVisitId, projectId);
  return refused;
}

/**
 * Correcting the floor a photograph was binned to (story 65), which ADR-0025
 * holds to one action. Blank means unbound, which is a real answer: "not this
 * floor" and "no window contained it" are the same fact about where it
 * belongs.
 */
export async function bindPhotoToFloor(
  photoId: string,
  siteVisitId: string,
  projectId: string,
  formData: FormData,
): Promise<void> {
  await sendOrThrow(`/photos/${photoId}/floor`, {
    floor: omitIfBlank(formData, 'floor') ?? null,
  });
  revalidatePhoto(siteVisitId, projectId);
}

/**
 * Correcting the finding a photograph evidences (story 65). Independent of
 * the floor above, because the two mechanisms are: a photograph binned to the
 * wrong floor and bound to the right finding needs one fixed, not both
 * restated.
 */
export async function bindPhotoToIssue(
  photoId: string,
  siteVisitId: string,
  projectId: string,
  formData: FormData,
): Promise<void> {
  const chosen = omitIfBlank(formData, 'issueNumber');
  await sendOrThrow(`/photos/${photoId}/issue`, {
    issueNumber: chosen === undefined ? null : Number(chosen),
  });
  revalidatePhoto(siteVisitId, projectId);
}

/**
 * Every screen a photograph appears on. The finding's is one of them: its
 * photo evidence is the rows pointing at it, so binding one changes that
 * screen without anything being written to the issue.
 */
function revalidatePhoto(siteVisitId: string, projectId: string): void {
  revalidateSiteVisit(siteVisitId, projectId);
  revalidatePath('/projects/[id]/issues/[number]', 'page');
}

// ── Issues ────────────────────────────────────────────────────────────────

/**
 * A sighting becomes a finding. The category is the whole of the form: what
 * was seen, when and where is already the observation's, and the identifier is
 * the API's to allocate.
 */
export async function raiseIssue(
  observationId: string,
  siteVisitId: string,
  projectId: string,
  previous: AddState,
  formData: FormData,
): Promise<AddState> {
  const error = await refusal(
    await send(`/observations/${observationId}/issue`, {
      category: formData.get('category'),
    }),
    201,
  );
  if (error !== undefined) {
    return { added: previous.added, error };
  }

  revalidateIssues(projectId, siteVisitId);
  return { added: previous.added + 1 };
}

/**
 * Still there on the second walk: this observation is another sighting of a
 * finding already on the register, so it joins that issue rather than raising
 * a second one under a new identifier.
 */
export async function reobserveIssue(
  observationId: string,
  siteVisitId: string,
  projectId: string,
  previous: AddState,
  formData: FormData,
): Promise<AddState> {
  const issueId = omitIfBlank(formData, 'issueId');
  if (issueId === undefined) {
    return { added: previous.added, error: 'choose the issue this is another sighting of' };
  }

  const error = await refusal(
    await send(`/issues/${issueId}/observations/${observationId}`),
    204,
  );
  if (error !== undefined) {
    return { added: previous.added, error };
  }

  revalidateIssues(projectId, siteVisitId);
  return { added: previous.added + 1 };
}

export async function closeIssue(
  issueId: string,
  projectId: string,
  formData: FormData,
): Promise<void> {
  // A finding closed in August must not read as closed today just because
  // that is when it was typed in.
  const on = omitIfBlank(formData, 'closedAt');

  await sendOrThrow(
    `/issues/${issueId}/close`,
    {
      note: formData.get('note'),
      ...(on === undefined ? {} : { closedAt: `${on}T00:00:00.000Z` }),
    },
    // Already closed is the second half of a double click; the re-render shows
    // what is actually true. Nothing else this route refuses is tolerated.
    { tolerated: 'that issue is already closed' },
  );
  revalidateIssues(projectId);
}

export async function reopenIssue(
  issueId: string,
  projectId: string,
): Promise<void> {
  await sendOrThrow(`/issues/${issueId}/reopen`, undefined, {
    tolerated: 'that issue is not closed',
  });
  revalidateIssues(projectId);
}

/**
 * An open item raised while looking at a finding. It is attached to the issue
 * and still lives on the project, so it does not disappear from the project
 * screen the moment it is tied to one — and it reaches the pending items view
 * carrying the job it is on, which is the whole of story 69.
 */
export async function createOpenItemOnIssue(
  issueId: string,
  projectId: string,
  previous: AddState,
  formData: FormData,
): Promise<AddState> {
  const error = await refusal(
    await send(`/issues/${issueId}/open-items`, openItemPayload(formData)),
    201,
  );
  if (error !== undefined) {
    return { added: previous.added, error };
  }

  revalidateIssues(projectId);
  revalidatePath('/pending');
  return { added: previous.added + 1 };
}

export async function attachOpenItemToIssue(
  issueId: string,
  projectId: string,
  formData: FormData,
): Promise<void> {
  const openItemId = formData.get('openItemId');
  if (openItemId === null || openItemId === '') {
    return;
  }

  await sendOrThrow(
    `/issues/${issueId}/open-items/${openItemId}`,
    undefined,
    // Already on this finding is the second half of a double click.
    { tolerated: 'that open item is already on this issue' },
  );
  revalidateIssues(projectId);
  revalidatePath('/pending');
}

/**
 * Every screen a finding appears on. The walk is passed where the change was
 * made from one, because the site visit screen says which of its observations
 * have become issues.
 */
function revalidateIssues(projectId: string, siteVisitId?: string): void {
  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/projects/[id]/issues/[number]', 'page');
  if (siteVisitId !== undefined) {
    revalidatePath(`/site-visits/${siteVisitId}`);
  }
}

// ── Voice capture and the draft observation (issue #12) ───────────────────

/**
 * Adding **one** recording to a walk (story 51). The API's refusal message, or
 * undefined when it took it.
 *
 * Accepted on **200 as well as 201**, which no other write here does. 201 is a
 * new recording; 200 is the one already stored under this key, which is what a
 * phone gets when it sends again after losing signal (story 112). Both mean
 * the same thing to the caller — the server has it and the phone may let go —
 * and treating the second as a refusal is exactly how a recording gets kept
 * forever or thrown away.
 *
 * `recordedAt` comes from the browser, because the browser is the only side
 * that knows which wall clock the engineer was reading.
 */
export interface CaptureRefusal {
  message: string;
  /**
   * Whether sending it again could ever succeed.
   *
   * A 4xx is the API understanding the recording and refusing it — a type it
   * does not store, a body over the cap — and it will refuse the identical
   * bytes every time. Holding one on the device would put a permanent banner
   * on the screen and resend it on every load forever, which is the opposite
   * of reconciling. Anything else is the send not arriving, which is exactly
   * what the device is holding it for.
   */
  permanent: boolean;
}

export async function addVoiceCapture(
  siteVisitId: string,
  projectId: string,
  captureKey: string,
  recordedAt: string,
  audio: File,
): Promise<CaptureRefusal | undefined> {
  const response = await send(`/site-visits/${siteVisitId}/voice-captures`, {
    captureKey,
    recordedAt,
    contentType: audio.type,
    bytes: Buffer.from(await audio.arrayBuffer()).toString('base64'),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    return {
      message: body.message ?? `the API returned ${response.status}`,
      permanent: response.status >= 400 && response.status < 500,
    };
  }

  revalidateSiteVisit(siteVisitId, projectId);
  return undefined;
}

/**
 * The draft, corrected, becoming an observation (story 52).
 *
 * The same fields the typed form sends, read the same way — the axis and its
 * value arrive together so the grammar cannot be corrupted by the interface.
 *
 * The time is left off unless the engineer typed one, so the API dates the
 * observation from the moment the recording was made rather than from the
 * evening it was reviewed.
 */
export async function commitVoiceCapture(
  voiceCaptureId: string,
  siteVisitId: string,
  visitedOn: string,
  projectId: string,
  previous: AddState,
  formData: FormData,
): Promise<AddState> {
  const axis = String(formData.get('axis') ?? 'side');
  const value = omitIfBlank(formData, 'axisValue');

  const error = await refusal(
    await send(`/voice-captures/${voiceCaptureId}/observation`, {
      observed: formData.get('observed'),
      observedAt: composeInstant(
        withDay(formData, visitedOn),
        'day',
        'observedAt',
      ),
      floor: formData.get('floor'),
      qualifier: formData.get('qualifier'),
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

/** Asking the vendor again. The audio never moved; only the failure is cleared. */
export async function retryVoiceCapture(
  voiceCaptureId: string,
  siteVisitId: string,
  projectId: string,
): Promise<void> {
  await sendOrThrow(`/voice-captures/${voiceCaptureId}/retry`);
  revalidateSiteVisit(siteVisitId, projectId);
}

/**
 * Generating the write-up of a walk (issue #13).
 *
 * A second press is a second report and never a refusal: nothing edits one, so
 * a correction is another rendering dated its own moment. That is what makes
 * this the answer to a finding that had no photograph — add the photograph,
 * generate again.
 */
export async function generateSiteVisitReport(
  siteVisitId: string,
  projectId: string,
): Promise<void> {
  await sendOrThrow(`/site-visits/${siteVisitId}/reports`);
  revalidateSiteVisit(siteVisitId, projectId);
}

// ── Registers, entries and the ball-in-court history (issue #14) ───────────

/** Every screen a register entry appears on. */
function revalidateRegisterEntry(entryId: string, registerId: string, projectId: string): void {
  revalidatePath(`/register-entries/${entryId}`);
  revalidatePath(`/registers/${registerId}`);
  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/pending');
  // Every one of these writes can move an entry on or off the daily list:
  // a handoff changes whose court it is, a disposition hands the ball back,
  // and a turnaround target is what "past" is measured against.
  revalidatePath('/clock');
}

/**
 * The turnaround target, where one was typed.
 *
 * Omitted rather than sent as null when the field is blank: the API refuses a
 * second target, so a form that sent one every time would make setting it
 * later impossible after the first save.
 */
function turnaroundPayload(formData: FormData): Record<string, unknown> {
  const days = omitIfBlank(formData, 'turnaroundDays');
  return days === undefined ? {} : { turnaroundDays: Number(days) };
}

/**
 * A handoff, read the same way whether it starts an entry or moves one on.
 *
 * The checkbox is the whole of whose court it is. It is not read off the party
 * name: a job that calls us by the firm's name still accrues, and the clock
 * sums exactly this field.
 */
function handoffPayload(formData: FormData): Record<string, unknown> {
  const since = omitIfBlank(formData, 'heldSince');
  return {
    party: formData.get('party'),
    inOurCourt: formData.get('inOurCourt') !== null,
    // A date input gives a day; the record keeps an instant.
    heldSince: since === undefined ? undefined : `${since}T00:00:00.000Z`,
  };
}

/**
 * Log a piece of correspondence. The first handoff is part of the same call:
 * an entry logged is already sitting in somebody's court.
 */
export async function createRegisterEntry(
  registerId: string,
  projectId: string,
  previous: AddState,
  formData: FormData,
): Promise<AddState> {
  const question = omitIfBlank(formData, 'question');
  const error = await refusal(
    await send(`/registers/${registerId}/entries`, {
      number: formData.get('number'),
      subject: formData.get('subject'),
      fromParty: formData.get('fromParty'),
      toParty: formData.get('toParty'),
      ...(question === undefined ? {} : { question }),
      ...turnaroundPayload(formData),
      ballInCourt: handoffPayload(formData),
    }),
    201,
  );
  if (error !== undefined) {
    return { added: previous.added, error };
  }

  revalidatePath(`/registers/${registerId}`);
  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/clock');
  return { added: previous.added + 1 };
}

/** Hand the ball on. Every handoff is a row and none is ever rewritten. */
export async function recordHandoff(
  entryId: string,
  registerId: string,
  projectId: string,
  previous: AddState,
  formData: FormData,
): Promise<AddState> {
  const error = await refusal(
    await send(`/register-entries/${entryId}/handoffs`, handoffPayload(formData)),
    201,
  );
  if (error !== undefined) {
    return { added: previous.added, error };
  }

  revalidateRegisterEntry(entryId, registerId, projectId);
  return { added: previous.added + 1 };
}

/** What came back. Recorded once; the API refuses a second. */
export async function recordResponse(
  entryId: string,
  registerId: string,
  projectId: string,
  previous: AddState,
  formData: FormData,
): Promise<AddState> {
  const error = await refusal(
    await send(`/register-entries/${entryId}/response`, {
      response: formData.get('response'),
    }),
    200,
  );
  if (error !== undefined) {
    return { added: previous.added, error };
  }

  revalidateRegisterEntry(entryId, registerId, projectId);
  return { added: previous.added + 1 };
}

/** The issuance that answered the entry, so the two are one story. */
export async function linkSubmission(
  entryId: string,
  registerId: string,
  projectId: string,
  previous: AddState,
  formData: FormData,
): Promise<AddState> {
  const error = await refusal(
    await send(`/register-entries/${entryId}/submission`, {
      submissionId: formData.get('submissionId'),
    }),
    200,
  );
  if (error !== undefined) {
    return { added: previous.added, error };
  }

  revalidateRegisterEntry(entryId, registerId, projectId);
  return { added: previous.added + 1 };
}

/** "Cannot review this until the load data arrives", where the clock runs. */
export async function createOpenItemOnRegisterEntry(
  entryId: string,
  registerId: string,
  projectId: string,
  previous: AddState,
  formData: FormData,
): Promise<AddState> {
  const error = await refusal(
    await send(`/register-entries/${entryId}/open-items`, openItemPayload(formData)),
    201,
  );
  if (error !== undefined) {
    return { added: previous.added, error };
  }

  revalidateRegisterEntry(entryId, registerId, projectId);
  return { added: previous.added + 1 };
}

/** An item already on the job, chased for this entry as well. */
export async function attachOpenItemToRegisterEntry(
  entryId: string,
  registerId: string,
  projectId: string,
  formData: FormData,
): Promise<void> {
  const openItemId = formData.get('openItemId');
  if (openItemId === null || openItemId === '') {
    return;
  }

  await sendOrThrow(
    `/register-entries/${entryId}/open-items/${openItemId}`,
    undefined,
    // Already on this entry is the second half of a double click.
    { tolerated: 'that open item is already on this entry' },
  );
  revalidateRegisterEntry(entryId, registerId, projectId);
}

// ── The clock and dispositions (issue #15) ────────────────────────────────

/**
 * The contractual number the clock is measured against (story 73).
 *
 * Set once; the API refuses a second. Moving a target would move which entries
 * were past their clock backwards through every day the number was different.
 */
export async function setTurnaround(
  entryId: string,
  registerId: string,
  projectId: string,
  previous: AddState,
  formData: FormData,
): Promise<AddState> {
  const error = await refusal(
    await send(`/register-entries/${entryId}/turnaround`, {
      turnaroundDays: Number(formData.get('turnaroundDays')),
    }),
    200,
  );
  if (error !== undefined) {
    return { added: previous.added, error };
  }

  revalidateRegisterEntry(entryId, registerId, projectId);
  return { added: previous.added + 1 };
}

/**
 * The outcome of a review: stop the clock and hand the ball back, in one call
 * (stories 75, 76).
 *
 * The party is typed rather than taken from the entry's `fromParty`. The two
 * parties on an entry are its fixed cast and are not read as whose move it is
 * (ADR-0036): a submittal reviewed for a contractor may go back to the
 * architect, and guessing would write a handoff nobody asked for into the
 * record a dispute is settled from.
 */
export async function recordDisposition(
  entryId: string,
  registerId: string,
  projectId: string,
  previous: AddState,
  formData: FormData,
): Promise<AddState> {
  const error = await refusal(
    await send(`/register-entries/${entryId}/disposition`, {
      disposition: formData.get('disposition'),
      ballInCourt: handoffPayload(formData),
    }),
    200,
  );
  if (error !== undefined) {
    return { added: previous.added, error };
  }

  revalidateRegisterEntry(entryId, registerId, projectId);
  return { added: previous.added + 1 };
}

/**
 * The round that came back, connected to the one it follows (story 77).
 *
 * A new entry pointing backwards; nothing is written to the round it replaces.
 * Its number is typed and never derived — an entry's number is the engineer's
 * and comes off the transmittal, so a convention invented here would be a
 * second identifier for a thing that already has one (ADR-0036).
 */
export async function createNextRound(
  entryId: string,
  registerId: string,
  projectId: string,
  previous: AddState,
  formData: FormData,
): Promise<AddState> {
  const error = await refusal(
    await send(`/register-entries/${entryId}/next-round`, {
      number: formData.get('number'),
      subject: formData.get('subject'),
      fromParty: formData.get('fromParty'),
      toParty: formData.get('toParty'),
      ...turnaroundPayload(formData),
      ballInCourt: handoffPayload(formData),
    }),
    201,
  );
  if (error !== undefined) {
    return { added: previous.added, error };
  }

  revalidateRegisterEntry(entryId, registerId, projectId);
  return { added: previous.added + 1 };
}

// ── Documents ─────────────────────────────────────────────────────────────

/**
 * The type a browser could not name for itself, by extension.
 *
 * The same fallback a photograph has, and the three here are exactly the three
 * the API stores. Anything else is sent as the empty string rather than
 * omitted, so the API refuses it by the same rule as any other bad type.
 */
const DOCUMENT_TYPE_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function documentTypeOf(file: File): string {
  if (file.type !== '') {
    return file.type;
  }
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return DOCUMENT_TYPE_BY_EXTENSION[extension] ?? '';
}

/**
 * One version, read the same way whether it is a document's first or a later
 * revision — so the two writers of that table cannot drift apart.
 *
 * Undefined when nothing was picked, which the callers answer for: a document
 * is recorded with its bytes or not at all, and an empty file part would reach
 * the API as a body it refuses for a reason nobody could act on.
 */
async function versionPayload(
  formData: FormData,
): Promise<Record<string, unknown> | undefined> {
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return undefined;
  }
  return {
    revision: formData.get('revision'),
    filename: file.name,
    contentType: documentTypeOf(file),
    bytes: Buffer.from(await file.arrayBuffer()).toString('base64'),
  };
}

/**
 * Whether the engineer said this is a referenced file.
 *
 * A tri-state on purpose, and never a checkbox: unticked and unanswered would
 * be the same value, and the unanswered one would classify an 86-sheet set as
 * something extraction may be pointed at. The API refuses a body with no
 * answer for that reason, and this refuses one before it is sent.
 */
function referencedFileAnswer(formData: FormData): boolean | undefined {
  const answer = formData.get('referencedFile');
  if (answer === 'true') {
    return true;
  }
  return answer === 'false' ? false : undefined;
}

/** Every screen a document appears on. */
function revalidateDocuments(projectId: string): void {
  revalidatePath(`/projects/${projectId}`);
  // A version pointed at by an issuance or an entry shows on those screens,
  // and both read the title and whether it is a referenced file off it.
  revalidatePath('/submissions/[id]', 'page');
  revalidatePath('/register-entries/[id]', 'page');
}

/** Storing a document against a job, with its first version (story 94). */
export async function addDocument(
  projectId: string,
  previous: AddState,
  formData: FormData,
): Promise<AddState> {
  const version = await versionPayload(formData);
  if (version === undefined) {
    return { added: previous.added, error: 'no file was chosen' };
  }

  const referencedFile = referencedFileAnswer(formData);
  if (referencedFile === undefined) {
    return {
      added: previous.added,
      error: 'say whether this is a referenced file',
    };
  }

  const error = await refusal(
    await send(`/projects/${projectId}/documents`, {
      title: formData.get('title'),
      referencedFile,
      version,
    }),
    201,
  );
  if (error !== undefined) {
    return { added: previous.added, error };
  }

  revalidateDocuments(projectId);
  return { added: previous.added + 1 };
}

/**
 * A newer revision of a document already stored (story 96).
 *
 * Nothing is written to the revisions before it, so what a submission was
 * issued against stays exactly what it was.
 */
export async function addDocumentVersion(
  documentId: string,
  projectId: string,
  previous: AddState,
  formData: FormData,
): Promise<AddState> {
  const version = await versionPayload(formData);
  if (version === undefined) {
    return { added: previous.added, error: 'no file was chosen' };
  }

  const error = await refusal(
    await send(`/documents/${documentId}/versions`, version),
    201,
  );
  if (error !== undefined) {
    return { added: previous.added, error };
  }

  revalidateDocuments(projectId);
  return { added: previous.added + 1 };
}

/**
 * Marking a document as a referenced file after the fact.
 *
 * One way. There is no action here that unmarks one and no route behind it:
 * a correction may always take a document out of extraction's reach and may
 * never put one into it.
 */
export async function markReferencedFile(
  documentId: string,
  projectId: string,
): Promise<void> {
  await sendOrThrow(`/documents/${documentId}/referenced-file`, undefined, {
    // Already a referenced file is the second half of a double click, and the
    // re-render shows what is actually true.
    tolerated: 'that document is already a referenced file',
  });
  revalidateDocuments(projectId);
}

/** The defined set points at the actual document (story 95). */
export async function linkDocumentToSubmission(
  submissionId: string,
  projectId: string,
  formData: FormData,
): Promise<void> {
  const versionId = formData.get('documentVersionId');
  if (versionId === null || versionId === '') {
    return;
  }

  await sendOrThrow(
    `/submissions/${submissionId}/documents/${versionId}`,
    undefined,
    // Already on this submission is the second half of a double click.
    { tolerated: 'that document is already on this submission' },
  );
  revalidatePath(`/submissions/${submissionId}`);
  revalidatePath(`/projects/${projectId}`);
}

/** What a piece of correspondence arrived with, or was answered by. */
export async function linkDocumentToRegisterEntry(
  entryId: string,
  registerId: string,
  projectId: string,
  formData: FormData,
): Promise<void> {
  const versionId = formData.get('documentVersionId');
  if (versionId === null || versionId === '') {
    return;
  }

  await sendOrThrow(
    `/register-entries/${entryId}/documents/${versionId}`,
    undefined,
    // Already on this entry is the second half of a double click.
    { tolerated: 'that document is already on this entry' },
  );
  revalidateRegisterEntry(entryId, registerId, projectId);
}
