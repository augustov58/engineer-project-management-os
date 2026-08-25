import { afterEach, expect, test } from 'vitest';
import {
  createOpenItem,
  createPhase,
  createProject,
  createSubmission,
  fakeTimeSource,
  openItemBody,
  startTestApi,
  submissionBody,
  type OpenItemResponse,
  type PhaseResponse,
  type SubmissionDetail,
  type SubmissionResponse,
  type TestApi,
} from './harness.js';

const started: TestApi[] = [];

async function api(options?: Parameters<typeof startTestApi>[0]) {
  const app = await startTestApi(options);
  started.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((instance) => instance.close()));
});

const json = { 'content-type': 'application/json' };

function post(app: TestApi, path: string, body?: unknown) {
  return app.fetch(path, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: json, body: JSON.stringify(body) }),
  });
}

async function phases(app: TestApi, projectId: string) {
  const response = await app.fetch(`/v1/projects/${projectId}/phases`);
  expect(response.status).toBe(200);
  return (await response.json()) as PhaseResponse[];
}

async function submissions(app: TestApi, projectId: string) {
  const response = await app.fetch(`/v1/projects/${projectId}/submissions`);
  expect(response.status).toBe(200);
  return (await response.json()) as SubmissionResponse[];
}

async function submission(app: TestApi, id: string) {
  const response = await app.fetch(`/v1/submissions/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as SubmissionDetail;
}

async function projectItems(app: TestApi, projectId: string) {
  const response = await app.fetch(`/v1/projects/${projectId}/open-items`);
  expect(response.status).toBe(200);
  return (await response.json()) as OpenItemResponse[];
}

const names = (rows: { name: string }[]) => rows.map((row) => row.name);

// ── Phases ────────────────────────────────────────────────────────────────

test('phases are defined per project as free text, in the order they are added', async () => {
  const app = await api();
  const project = await createProject(app, 'S-1', 'Riverside clinic');

  await createPhase(app, project.id, '50% CD');
  await createPhase(app, project.id, '90% CD');
  await createPhase(app, project.id, 'Building Permit Set');

  const defined = await phases(app, project.id);
  expect(names(defined)).toEqual(['50% CD', '90% CD', 'Building Permit Set']);
  expect(defined.map((phase) => phase.position)).toEqual([0, 1, 2]);
  expect(defined.every((phase) => phase.projectId === project.id)).toBe(true);
});

test('a phase is renamed, and what was issued at it reads the new name', async () => {
  const app = await api();
  const project = await createProject(app, 'S-1', 'Riverside clinic');
  const phase = await createPhase(app, project.id, '90% CD');
  const issued = await createSubmission(app, project.id, { phaseId: phase.id });

  const renamed = await post(app, `/v1/phases/${phase.id}/rename`, {
    name: '90% Construction Documents',
  });
  expect(renamed.status).toBe(200);

  // A rename is the same body of work under a better name, so it propagates
  // to what was issued at it (ADR-0026). The submission itself is untouched.
  const detail = await submission(app, issued.id);
  expect(detail.phase.name).toBe('90% Construction Documents');
  expect(detail.phaseId).toBe(phase.id);
  expect(detail.revision).toBe(issued.revision);
});

test('phases are reordered by submitting the whole ordered list', async () => {
  const app = await api();
  const project = await createProject(app, 'S-1', 'Riverside clinic');
  const first = await createPhase(app, project.id, '50% CD');
  const second = await createPhase(app, project.id, '90% CD');
  const third = await createPhase(app, project.id, 'Building Permit Set');

  const reordered = await post(app, `/v1/projects/${project.id}/phases/order`, {
    phaseIds: [third.id, first.id, second.id],
  });
  expect(reordered.status).toBe(200);

  const after = await phases(app, project.id);
  expect(names(after)).toEqual(['Building Permit Set', '50% CD', '90% CD']);
  expect(after.map((phase) => phase.position)).toEqual([0, 1, 2]);
});

test("two projects carry different phase sets and neither sees the other's", async () => {
  const app = await api();
  const runsFifty = await createProject(app, 'S-1', 'Riverside clinic');
  const skipsFifty = await createProject(app, 'S-2', 'Harbour depot');

  await createPhase(app, runsFifty.id, '50% CD');
  await createPhase(app, runsFifty.id, '90% CD');
  // The same name on another job is a different phase, and a different row.
  await createPhase(app, skipsFifty.id, '90% CD');
  await createPhase(app, skipsFifty.id, 'Building Permit Set');

  expect(names(await phases(app, runsFifty.id))).toEqual(['50% CD', '90% CD']);
  expect(names(await phases(app, skipsFifty.id))).toEqual([
    '90% CD',
    'Building Permit Set',
  ]);

  const [theirs] = await phases(app, skipsFifty.id);
  const crossed = await post(app, `/v1/projects/${runsFifty.id}/phases/order`, {
    phaseIds: [theirs!.id],
  });
  expect(crossed.status).toBe(409);
});

test('a duplicate phase name within a project is refused', async () => {
  const app = await api();
  const project = await createProject(app, 'S-1', 'Riverside clinic');
  await createPhase(app, project.id, '90% CD');

  const again = await post(app, `/v1/projects/${project.id}/phases`, {
    name: '90% CD',
  });
  expect(again.status).toBe(409);
  expect(names(await phases(app, project.id))).toEqual(['90% CD']);
});

test("a reorder that does not name exactly the project's phases is refused", async () => {
  const app = await api();
  const project = await createProject(app, 'S-1', 'Riverside clinic');
  const first = await createPhase(app, project.id, '50% CD');
  await createPhase(app, project.id, '90% CD');

  const path = `/v1/projects/${project.id}/phases/order`;
  // Short of the full set would silently drop a phase's position.
  expect((await post(app, path, { phaseIds: [first.id] })).status).toBe(409);
  // A repeat would give two phases the same place.
  expect(
    (await post(app, path, { phaseIds: [first.id, first.id] })).status,
  ).toBe(409);

  expect((await phases(app, project.id)).map((p) => p.position)).toEqual([0, 1]);
});

// ── The current phase ─────────────────────────────────────────────────────

test('a project carries a current phase, and a new submission defaults to it', async () => {
  const app = await api();
  const project = await createProject(app, 'S-1', 'Riverside clinic');
  await createPhase(app, project.id, '50% CD');
  const ninety = await createPhase(app, project.id, '90% CD');

  const set = await post(app, `/v1/projects/${project.id}/current-phase`, {
    phaseId: ninety.id,
  });
  expect(set.status).toBe(200);
  expect(((await set.json()) as { currentPhaseId: string }).currentPhaseId).toBe(
    ninety.id,
  );

  const read = await app.fetch(`/v1/projects/${project.id}`);
  expect(((await read.json()) as { currentPhaseId: string }).currentPhaseId).toBe(
    ninety.id,
  );

  const issued = await createSubmission(app, project.id);
  expect(issued.phaseId).toBe(ninety.id);
});

test('a submission may name a phase other than the current one', async () => {
  const app = await api();
  const project = await createProject(app, 'S-1', 'Riverside clinic');
  const fifty = await createPhase(app, project.id, '50% CD');
  const ninety = await createPhase(app, project.id, '90% CD');
  await post(app, `/v1/projects/${project.id}/current-phase`, {
    phaseId: ninety.id,
  });

  const issued = await createSubmission(app, project.id, { phaseId: fifty.id });
  expect(issued.phaseId).toBe(fifty.id);
});

test("another project's phase can be neither made current nor issued at", async () => {
  const app = await api();
  const ours = await createProject(app, 'S-1', 'Riverside clinic');
  const theirs = await createProject(app, 'S-2', 'Harbour depot');
  const elsewhere = await createPhase(app, theirs.id, '90% CD');

  const madeCurrent = await post(
    app,
    `/v1/projects/${ours.id}/current-phase`,
    { phaseId: elsewhere.id },
  );
  expect(madeCurrent.status).toBe(409);

  const issued = await post(
    app,
    `/v1/projects/${ours.id}/submissions`,
    submissionBody({ phaseId: elsewhere.id }),
  );
  expect(issued.status).toBe(409);
});

test('recording a submission with no phase and no current phase is refused', async () => {
  const app = await api();
  const project = await createProject(app, 'S-1', 'Riverside clinic');

  // Every definition in the corpus says a submission is issued "at a phase",
  // so a job defines one before it records an issuance.
  const issued = await post(
    app,
    `/v1/projects/${project.id}/submissions`,
    submissionBody(),
  );
  expect(issued.status).toBe(409);
  expect(await submissions(app, project.id)).toEqual([]);
});

// ── The submission itself ─────────────────────────────────────────────────

test('a submission is read back with every field it was recorded with', async () => {
  const app = await api();
  const project = await createProject(app, 'S-1', 'Riverside clinic');
  const phase = await createPhase(app, project.id, '90% CD');

  const response = await post(
    app,
    `/v1/projects/${project.id}/submissions`,
    submissionBody({
      phaseId: phase.id,
      issuedAt: '2026-04-14T00:00:00.000Z',
      recipient: 'Wren Alcott',
      recipientRole: 'EOR',
      revision: 'Rev 2',
      sheetList: 'E0.01\nE1.01\nE2.01',
    }),
  );
  expect(response.status).toBe(201);

  const detail = await submission(
    app,
    ((await response.json()) as SubmissionResponse).id,
  );
  expect(detail).toMatchObject({
    projectId: project.id,
    phaseId: phase.id,
    issuedAt: '2026-04-14T00:00:00.000Z',
    recipient: 'Wren Alcott',
    recipientRole: 'EOR',
    revision: 'Rev 2',
    sheetList: 'E0.01\nE1.01\nE2.01',
  });
  expect(detail.phase.name).toBe('90% CD');
  expect(detail.project.projectNumber).toBe('S-1');
  expect(detail.openItems).toEqual([]);
});

test('the issuance date defaults to the injected time source and is otherwise honoured', async () => {
  const clock = fakeTimeSource(new Date('2026-08-25T09:00:00.000Z'));
  const app = await api({ timeSource: clock });
  const project = await createProject(app, 'S-1', 'Riverside clinic');
  const phase = await createPhase(app, project.id, '90% CD');

  const today = await createSubmission(app, project.id, { phaseId: phase.id });
  expect(today.issuedAt).toBe('2026-08-25T09:00:00.000Z');

  // A set that went out in April, entered in August, is dated April.
  const backdated = await createSubmission(app, project.id, {
    phaseId: phase.id,
    issuedAt: '2026-04-14T00:00:00.000Z',
  });
  expect(backdated.issuedAt).toBe('2026-04-14T00:00:00.000Z');
});

test("a project's submissions list in issuance order, oldest first", async () => {
  const clock = fakeTimeSource(new Date('2026-08-25T09:00:00.000Z'));
  const app = await api({ timeSource: clock });
  const project = await createProject(app, 'S-1', 'Riverside clinic');
  const phase = await createPhase(app, project.id, '90% CD');

  const august = await createSubmission(app, project.id, { phaseId: phase.id });
  const april = await createSubmission(app, project.id, {
    phaseId: phase.id,
    issuedAt: '2026-04-14T00:00:00.000Z',
    revision: 'Rev 1',
  });
  clock.advance(60_000);
  const alsoApril = await createSubmission(app, project.id, {
    phaseId: phase.id,
    issuedAt: '2026-04-14T00:00:00.000Z',
    revision: 'Rev 1a',
  });

  const listed = await submissions(app, project.id);
  expect(listed.map((row) => row.id)).toEqual([
    april.id,
    alsoApril.id,
    august.id,
  ]);

  // Two sets issued the same day fall back on the order they were entered,
  // which is why the record keeps a created_at beside the issuance date.
  //
  // Stated honestly: this seam cannot falsify that tie-break. Freshly
  // inserted rows come back in insertion order anyway, so dropping
  // `createdAt` from the sort leaves this test green — it was checked by
  // hand. What the tie-break buys is a *specified* order rather than one
  // that happens to hold; what is asserted below is the part that is real.
  expect(april.createdAt).toBe('2026-08-25T09:00:00.000Z');
  expect(alsoApril.createdAt).toBe('2026-08-25T09:01:00.000Z');
  expect(new Date(alsoApril.createdAt).getTime()).toBeGreaterThan(
    new Date(april.createdAt).getTime(),
  );
});

test('a submission carries no route that edits it', async () => {
  const app = await api();
  const project = await createProject(app, 'S-1', 'Riverside clinic');
  const phase = await createPhase(app, project.id, '90% CD');
  const issued = await createSubmission(app, project.id, { phaseId: phase.id });

  // Issue #7 forbids any path that edits an issued submission. Shipping no
  // such route is what makes that true by construction (ADR-0026).
  for (const method of ['PATCH', 'PUT', 'DELETE']) {
    const response = await app.fetch(`/v1/submissions/${issued.id}`, {
      method,
      headers: json,
      body: JSON.stringify({ revision: 'Rev 9' }),
    });
    expect(response.status, `${method} /v1/submissions/:id`).toBe(404);
  }

  expect((await submission(app, issued.id)).revision).toBe(issued.revision);
});

test('what a set rests on is named while the issuance is recorded', async () => {
  const app = await api();
  const project = await createProject(app, 'S-1', 'Riverside clinic');
  const phase = await createPhase(app, project.id, '90% CD');
  const first = await createOpenItem(app, project.id);
  const second = await createOpenItem(app, project.id, {
    unresolved: 'Panel schedule not returned',
  });

  // Issue #6 stamps whether a set went out on unconfirmed inputs at the
  // moment of issuance and never recomputes it, so the row and what it rests
  // on have to exist together at that moment.
  const response = await post(
    app,
    `/v1/projects/${project.id}/submissions`,
    submissionBody({ phaseId: phase.id, openItemIds: [first.id, second.id] }),
  );
  expect(response.status).toBe(201);

  const detail = await submission(
    app,
    ((await response.json()) as SubmissionResponse).id,
  );
  expect(detail.openItems.map((row) => row.id).sort()).toEqual(
    [first.id, second.id].sort(),
  );
  // And they are still the project's own items, not moved onto the set.
  expect(await projectItems(app, project.id)).toHaveLength(2);
});

test('a set cannot be recorded as resting on something that is not the project\'s', async () => {
  const app = await api();
  const ours = await createProject(app, 'S-1', 'Riverside clinic');
  const theirs = await createProject(app, 'S-2', 'Harbour depot');
  const phase = await createPhase(app, ours.id, '90% CD');
  const mine = await createOpenItem(app, ours.id);
  const elsewhere = await createOpenItem(app, theirs.id);
  const absent = '00000000-0000-4000-8000-000000000000';

  const crossed = await post(
    app,
    `/v1/projects/${ours.id}/submissions`,
    submissionBody({ phaseId: phase.id, openItemIds: [elsewhere.id] }),
  );
  expect(crossed.status).toBe(409);

  const missing = await post(
    app,
    `/v1/projects/${ours.id}/submissions`,
    submissionBody({ phaseId: phase.id, openItemIds: [absent] }),
  );
  expect(missing.status).toBe(404);

  // Naming the same item twice would claim it twice.
  const twice = await post(
    app,
    `/v1/projects/${ours.id}/submissions`,
    submissionBody({ phaseId: phase.id, openItemIds: [mine.id, mine.id] }),
  );
  expect(twice.status).toBe(409);

  // None of the three left a half-written submission behind.
  expect(await submissions(app, ours.id)).toEqual([]);
});

test('detaching what was never attached says so, and does not blame the submission', async () => {
  const app = await api();
  const project = await createProject(app, 'S-1', 'Riverside clinic');
  const phase = await createPhase(app, project.id, '90% CD');
  const issued = await createSubmission(app, project.id, { phaseId: phase.id });
  const unattached = await createOpenItem(app, project.id);

  const response = await app.fetch(
    `/v1/submissions/${issued.id}/open-items/${unattached.id}`,
    { method: 'DELETE' },
  );
  expect(response.status).toBe(404);
  // The submission exists; saying otherwise sends the reader to the wrong
  // record entirely.
  const { message } = (await response.json()) as { message: string };
  expect(message).toBe('that open item is not on this submission');
});

test('a submission cannot carry a field the record does not have', async () => {
  const app = await api();
  const project = await createProject(app, 'S-1', 'Riverside clinic');
  const phase = await createPhase(app, project.id, '90% CD');

  const response = await post(app, `/v1/projects/${project.id}/submissions`, {
    ...submissionBody({ phaseId: phase.id }),
    // Issue #6 stamps this; a caller must not be able to assert it.
    issuedProvisional: true,
  });
  expect(response.status).toBe(400);
});

test('an unparseable issuance date is refused', async () => {
  const app = await api();
  const project = await createProject(app, 'S-1', 'Riverside clinic');
  const phase = await createPhase(app, project.id, '90% CD');

  const response = await post(
    app,
    `/v1/projects/${project.id}/submissions`,
    submissionBody({ phaseId: phase.id, issuedAt: 'last April' }),
  );
  expect(response.status).toBe(400);
  expect(await submissions(app, project.id)).toEqual([]);
});

test.each([
  ['recipient', '   '],
  ['recipientRole', ''],
  ['revision', ' '],
  ['sheetList', '  '],
])('a blank %s is refused', async (field, value) => {
  const app = await api();
  const project = await createProject(app, 'S-1', 'Riverside clinic');
  const phase = await createPhase(app, project.id, '90% CD');

  const response = await post(
    app,
    `/v1/projects/${project.id}/submissions`,
    submissionBody({ phaseId: phase.id, [field]: value }),
  );
  expect(response.status).toBe(400);
});

// ── What an issuance rests on ─────────────────────────────────────────────

test('an existing open item is attached to a submission and seen on it', async () => {
  const app = await api();
  const project = await createProject(app, 'S-1', 'Riverside clinic');
  const phase = await createPhase(app, project.id, '90% CD');
  const issued = await createSubmission(app, project.id, { phaseId: phase.id });
  const item = await createOpenItem(app, project.id);

  const attached = await post(
    app,
    `/v1/submissions/${issued.id}/open-items/${item.id}`,
  );
  expect(attached.status).toBe(204);

  const detail = await submission(app, issued.id);
  expect(detail.openItems.map((row) => row.id)).toEqual([item.id]);
  expect(detail.openItems[0]!.unresolved).toBe(item.unresolved);
});

test('an open item created against a submission stays on its project too', async () => {
  const app = await api();
  const project = await createProject(app, 'S-1', 'Riverside clinic');
  const phase = await createPhase(app, project.id, '90% CD');
  const issued = await createSubmission(app, project.id, { phaseId: phase.id });

  const response = await post(
    app,
    `/v1/submissions/${issued.id}/open-items`,
    openItemBody(),
  );
  expect(response.status).toBe(201);
  const item = (await response.json()) as OpenItemResponse;

  // The subject says where an item lives, the join says which issuances rest
  // on it (ADR-0026). Creating one here must not take it off the project —
  // an item that vanished from the project screen would be the opposite of
  // "nothing sitting in my court".
  expect(item.subjectType).toBe('PROJECT');
  expect(item.subjectId).toBe(project.id);
  expect((await projectItems(app, project.id)).map((row) => row.id)).toEqual([
    item.id,
  ]);
  expect(
    (await submission(app, issued.id)).openItems.map((row) => row.id),
  ).toEqual([item.id]);
});

test('one open item backs several issuances at once', async () => {
  const app = await api();
  const project = await createProject(app, 'S-1', 'Riverside clinic');
  const phase = await createPhase(app, project.id, '90% CD');
  const first = await createSubmission(app, project.id, { phaseId: phase.id });
  const second = await createSubmission(app, project.id, {
    phaseId: phase.id,
    revision: 'Rev 2',
  });
  const item = await createOpenItem(app, project.id);

  for (const issued of [first, second]) {
    const attached = await post(
      app,
      `/v1/submissions/${issued.id}/open-items/${item.id}`,
    );
    expect(attached.status).toBe(204);
  }

  // One record, however many sets rested on it — which is what makes issue
  // #7's carry-forward an insert rather than a move.
  for (const issued of [first, second]) {
    expect(
      (await submission(app, issued.id)).openItems.map((row) => row.id),
    ).toEqual([item.id]);
  }
  expect(await projectItems(app, project.id)).toHaveLength(1);
});

test('resolving an attached open item leaves it attached', async () => {
  const app = await api();
  const project = await createProject(app, 'S-1', 'Riverside clinic');
  const phase = await createPhase(app, project.id, '90% CD');
  const issued = await createSubmission(app, project.id, { phaseId: phase.id });
  const item = await createOpenItem(app, project.id);
  await post(app, `/v1/submissions/${issued.id}/open-items/${item.id}`);

  const resolved = await post(app, `/v1/open-items/${item.id}/resolve`, {
    note: 'Confirmed by the contractor',
  });
  expect(resolved.status).toBe(200);

  // What an issuance rested on survives the resolution — the historical fact
  // issue #6 must not let cleanup erase.
  const detail = await submission(app, issued.id);
  expect(detail.openItems.map((row) => row.id)).toEqual([item.id]);
  expect(detail.openItems[0]!.resolvedAt).not.toBeNull();
});

test('attaching the same open item twice is refused, and detaching removes it', async () => {
  const app = await api();
  const project = await createProject(app, 'S-1', 'Riverside clinic');
  const phase = await createPhase(app, project.id, '90% CD');
  const issued = await createSubmission(app, project.id, { phaseId: phase.id });
  const item = await createOpenItem(app, project.id);

  const path = `/v1/submissions/${issued.id}/open-items/${item.id}`;
  expect((await post(app, path)).status).toBe(204);
  expect((await post(app, path)).status).toBe(409);

  const detached = await app.fetch(path, { method: 'DELETE' });
  expect(detached.status).toBe(204);
  expect((await submission(app, issued.id)).openItems).toEqual([]);
  // Detaching says nothing about the item itself; it stays on its project.
  expect(await projectItems(app, project.id)).toHaveLength(1);
});

test("an open item on another project cannot be attached", async () => {
  const app = await api();
  const ours = await createProject(app, 'S-1', 'Riverside clinic');
  const theirs = await createProject(app, 'S-2', 'Harbour depot');
  const phase = await createPhase(app, ours.id, '90% CD');
  const issued = await createSubmission(app, ours.id, { phaseId: phase.id });
  const elsewhere = await createOpenItem(app, theirs.id);

  const attached = await post(
    app,
    `/v1/submissions/${issued.id}/open-items/${elsewhere.id}`,
  );
  expect(attached.status).toBe(409);
  expect((await submission(app, issued.id)).openItems).toEqual([]);
});

// ── Not found ─────────────────────────────────────────────────────────────

test('an unknown project, phase or submission is a 404 everywhere it is named', async () => {
  const app = await api();
  const project = await createProject(app, 'S-1', 'Riverside clinic');
  const phase = await createPhase(app, project.id, '90% CD');
  const issued = await createSubmission(app, project.id, { phaseId: phase.id });
  const item = await createOpenItem(app, project.id);
  const absent = '00000000-0000-4000-8000-000000000000';

  const gone = [
    await app.fetch(`/v1/projects/${absent}/phases`),
    await post(app, `/v1/projects/${absent}/phases`, { name: '90% CD' }),
    await post(app, `/v1/projects/${absent}/phases/order`, { phaseIds: [] }),
    await post(app, `/v1/projects/${absent}/current-phase`, {
      phaseId: phase.id,
    }),
    await post(app, `/v1/projects/${project.id}/current-phase`, {
      phaseId: absent,
    }),
    await post(app, `/v1/phases/${absent}/rename`, { name: 'Permit' }),
    await app.fetch(`/v1/projects/${absent}/submissions`),
    await post(app, `/v1/projects/${absent}/submissions`, submissionBody()),
    await app.fetch(`/v1/submissions/${absent}`),
    await post(app, `/v1/submissions/${absent}/open-items/${item.id}`),
    await post(app, `/v1/submissions/${issued.id}/open-items/${absent}`),
    await app.fetch(`/v1/submissions/${issued.id}/open-items/${absent}`, {
      method: 'DELETE',
    }),
  ];

  expect(gone.map((response) => response.status)).toEqual(gone.map(() => 404));
});
