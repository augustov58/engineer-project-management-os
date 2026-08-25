import { afterEach, expect, test } from 'vitest';
import {
  createOpenItem,
  createPhase,
  createProject,
  createSubmission,
  reissueSubmission,
  startTestApi,
  submissionBody,
  type ExposureRow,
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

async function submission(app: TestApi, id: string) {
  const response = await app.fetch(`/v1/submissions/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as SubmissionDetail;
}

async function submissions(app: TestApi, projectId: string) {
  const response = await app.fetch(`/v1/projects/${projectId}/submissions`);
  expect(response.status).toBe(200);
  return (await response.json()) as SubmissionResponse[];
}

async function exposure(app: TestApi, projectId?: string) {
  const path =
    projectId === undefined
      ? '/v1/exposure'
      : `/v1/exposure?projectId=${projectId}`;
  const response = await app.fetch(path);
  expect(response.status).toBe(200);
  return (await response.json()) as ExposureRow[];
}

/** A project with a phase, which is all a submission needs to exist. */
async function job(app: TestApi, number: string, name: string) {
  const project = await createProject(app, number, name);
  const phase = await createPhase(app, project.id, '90% CD');
  return { project, phase };
}

async function resolve(app: TestApi, itemId: string) {
  const response = await post(app, `/v1/open-items/${itemId}/resolve`, {
    note: 'Confirmed by the contractor',
  });
  expect(response.status).toBe(200);
}

const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

// ── A correction is a new record, never an edit ────────────────────────────

test('reissuing produces a new submission that points at the one it supersedes', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const first = await createSubmission(app, project.id, {
    phaseId: phase.id,
    revision: 'Rev 1',
  });

  const response = await post(
    app,
    `/v1/submissions/${first.id}/reissue`,
    submissionBody({ revision: 'Rev 2', sheetList: 'E0.01\nE1.01\nE2.02' }),
  );
  expect(response.status).toBe(201);
  const second = (await response.json()) as SubmissionResponse;

  expect(second.id).not.toBe(first.id);
  expect(second.supersedesId).toBe(first.id);
  expect(second.supersededById).toBeNull();
  // The lineage stays on one job and, unless the reissue says otherwise, at
  // the same stage: this is another issuance of the same set.
  expect(second.projectId).toBe(project.id);
  expect(second.phaseId).toBe(phase.id);

  // Both are in the register. Superseding is not deleting.
  expect(ids(await submissions(app, project.id))).toEqual([first.id, second.id]);
});

test('the superseded submission stays readable and reads as superseded', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const first = await createSubmission(app, project.id, {
    phaseId: phase.id,
    revision: 'Rev 1',
    recipient: 'Wren Alcott',
    sheetList: 'E0.01\nE1.01',
  });
  const second = await reissueSubmission(app, first.id, { revision: 'Rev 2' });

  const superseded = await submission(app, first.id);
  expect(superseded.supersededById).toBe(second.id);
  expect(superseded.supersedesId).toBeNull();
  // Every word of what went out is still exactly what it was.
  expect(superseded.revision).toBe('Rev 1');
  expect(superseded.recipient).toBe('Wren Alcott');
  expect(superseded.sheetList).toBe('E0.01\nE1.01');
  expect(superseded.issuedAt).toBe(first.issuedAt);

  const current = await submission(app, second.id);
  expect(current.supersedesId).toBe(first.id);
  expect(current.supersededById).toBeNull();
});

test('a submission can be superseded by at most one successor', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const first = await createSubmission(app, project.id, { phaseId: phase.id });
  const second = await reissueSubmission(app, first.id, { revision: 'Rev 2' });

  const again = await post(
    app,
    `/v1/submissions/${first.id}/reissue`,
    submissionBody({ revision: 'Rev 2 again' }),
  );
  expect(again.status).toBe(409);
  expect((await again.json()) as { message: string }).toEqual({
    message: 'that submission has already been superseded',
  });

  // The chain did not fork, and nothing was written.
  expect(ids(await submissions(app, project.id))).toEqual([first.id, second.id]);
});

test('two reissues racing for the same predecessor still leave one successor', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const first = await createSubmission(app, project.id, { phaseId: phase.id });

  // Both can pass the "already superseded?" check before either insert lands.
  // The unique index is what settles it, and the route has to turn that into
  // the same sentence rather than a 500.
  const both = await Promise.all([
    post(app, `/v1/submissions/${first.id}/reissue`, submissionBody({ revision: 'Rev 2' })),
    post(app, `/v1/submissions/${first.id}/reissue`, submissionBody({ revision: 'Rev 2 rival' })),
  ]);
  // Numeric, not the default lexicographic sort: right for 201 and 409 either
  // way, and wrong the moment a third status joins them.
  const codes = both.map((response) => response.status).sort((a, b) => a - b);
  expect(codes).toEqual([201, 409]);

  const refused = both.find((response) => response.status === 409)!;
  expect((await refused.json()) as { message: string }).toEqual({
    message: 'that submission has already been superseded',
  });

  // One predecessor, one successor, whichever way the race went.
  const recorded = await submissions(app, project.id);
  expect(recorded).toHaveLength(2);
  expect((await submission(app, first.id)).chain).toHaveLength(2);
});

test('the chain is linear and reads end to end from any submission in it', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const first = await createSubmission(app, project.id, {
    phaseId: phase.id,
    revision: 'Rev 1',
  });
  const second = await reissueSubmission(app, first.id, { revision: 'Rev 2' });
  const third = await reissueSubmission(app, second.id, { revision: 'Rev 3' });

  const lineage = [first.id, second.id, third.id];
  for (const id of lineage) {
    const read = await submission(app, id);
    // Oldest issuance first, and the same list whichever link you came in by.
    expect(ids(read.chain), `chain read from ${id}`).toEqual(lineage);
    expect(read.chain.map((entry) => entry.revision)).toEqual([
      'Rev 1',
      'Rev 2',
      'Rev 3',
    ]);
    // The current issuance is identifiable from the chain, and there is
    // exactly one of it.
    expect(read.chain.filter((entry) => entry.current).map((e) => e.id)).toEqual(
      [third.id],
    );
  }
});

test('a submission that supersedes nothing is a chain of one, and is current', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const only = await createSubmission(app, project.id, { phaseId: phase.id });

  const read = await submission(app, only.id);
  expect(read.chain).toHaveLength(1);
  expect(read.chain[0]?.id).toBe(only.id);
  expect(read.chain[0]?.current).toBe(true);
});

// ── What the reissue rests on ─────────────────────────────────────────────

test('open items carry forward to a reissue by default', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const height = await createOpenItem(app, project.id, {
    unresolved: 'Ceiling height at the north stair',
  });
  const feeder = await createOpenItem(app, project.id, {
    unresolved: 'Feeder route through the corridor',
  });
  const first = await createSubmission(app, project.id, {
    phaseId: phase.id,
    openItemIds: [height.id, feeder.id],
  });

  // No `openItemIds` at all: a reissue must not silently lose what the
  // original rested on.
  const second = await reissueSubmission(app, first.id, { revision: 'Rev 2' });

  const carried = await submission(app, second.id);
  expect(ids(carried.openItems).sort()).toEqual([height.id, feeder.id].sort());
  // Named at this issuance, so this set went out on them too.
  expect(
    carried.openItems.every((item) => item.unresolvedAtIssuance === true),
  ).toBe(true);
  expect(carried.issuedProvisional).toBe(true);

  // The predecessor's own record of what it rested on is untouched.
  const superseded = await submission(app, first.id);
  expect(ids(superseded.openItems).sort()).toEqual([height.id, feeder.id].sort());
});

test('a reissue rests on exactly the open items it names', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const height = await createOpenItem(app, project.id, {
    unresolved: 'Ceiling height at the north stair',
  });
  const feeder = await createOpenItem(app, project.id, {
    unresolved: 'Feeder route through the corridor',
  });
  const first = await createSubmission(app, project.id, {
    phaseId: phase.id,
    openItemIds: [height.id, feeder.id],
  });

  // Editing the carry-forward before committing: one of the two is no longer
  // something this set stands on.
  const second = await reissueSubmission(app, first.id, {
    revision: 'Rev 2',
    openItemIds: [feeder.id],
  });
  expect(ids((await submission(app, second.id)).openItems)).toEqual([feeder.id]);

  // An empty list is a deliberate drop, not an omission — and it is the one
  // way to say a reissue rests on nothing.
  const third = await reissueSubmission(app, second.id, {
    revision: 'Rev 3',
    openItemIds: [],
  });
  const clean = await submission(app, third.id);
  expect(clean.openItems).toEqual([]);
  expect(clean.issuedProvisional).toBe(false);
});

test('carrying forward stamps what was unresolved at the reissue, not at the original', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const height = await createOpenItem(app, project.id);
  const first = await createSubmission(app, project.id, {
    phaseId: phase.id,
    openItemIds: [height.id],
  });
  expect(first.issuedProvisional).toBe(true);

  await resolve(app, height.id);
  const second = await reissueSubmission(app, first.id, { revision: 'Rev 2' });

  // The reissue went out on a confirmed input, so it is not provisional —
  // and the item still carried forward, because the set still rests on it.
  expect(second.issuedProvisional).toBe(false);
  const carried = await submission(app, second.id);
  expect(ids(carried.openItems)).toEqual([height.id]);
  expect(carried.openItems[0]?.unresolvedAtIssuance).toBe(false);

  // What the original went out on is not rewritten by a later issuance.
  const superseded = await submission(app, first.id);
  expect(superseded.issuedProvisional).toBe(true);
  expect(superseded.openItems[0]?.unresolvedAtIssuance).toBe(true);
});

test('a carried-forward item is still part of the successor issuance and cannot be detached', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const height = await createOpenItem(app, project.id);
  const first = await createSubmission(app, project.id, {
    phaseId: phase.id,
    openItemIds: [height.id],
  });
  const second = await reissueSubmission(app, first.id, { revision: 'Rev 2' });

  const response = await app.fetch(
    `/v1/submissions/${second.id}/open-items/${height.id}`,
    { method: 'DELETE' },
  );
  expect(response.status).toBe(409);
  expect((await response.json()) as { message: string }).toEqual({
    message: 'this submission was issued resting on that open item',
  });
});

// ── Exposure counts what is actually out there ────────────────────────────

test('exposure counts the current issuance, not the superseded ancestors', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const height = await createOpenItem(app, project.id);
  const first = await createSubmission(app, project.id, {
    phaseId: phase.id,
    openItemIds: [height.id],
  });
  expect(ids(await exposure(app))).toEqual([first.id]);

  const second = await reissueSubmission(app, first.id, { revision: 'Rev 2' });

  // Both carry the same unresolved item, and the count did not double: only
  // one of them is what is out there.
  expect(ids(await exposure(app))).toEqual([second.id]);
  expect(ids(await exposure(app, project.id))).toEqual([second.id]);
});

test('a reissue that drops the unresolved item takes the set out of exposure entirely', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const height = await createOpenItem(app, project.id);
  const first = await createSubmission(app, project.id, {
    phaseId: phase.id,
    openItemIds: [height.id],
  });

  await reissueSubmission(app, first.id, { revision: 'Rev 2', openItemIds: [] });

  // The superseded set still stands on an unresolved item, and is still
  // marked so on its own record — it just is not what is out there.
  expect(await exposure(app)).toEqual([]);
  expect((await submission(app, first.id)).currentlyProvisional).toBe(true);
});

// ── Nothing edits an issuance ─────────────────────────────────────────────

test('an issued submission cannot be edited or deleted by any route', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const issued = await createSubmission(app, project.id, {
    phaseId: phase.id,
    revision: 'Rev 1',
    recipient: 'Wren Alcott',
    sheetList: 'E0.01\nE1.01',
  });

  const edit = JSON.stringify({
    recipient: 'Somebody else',
    revision: 'Rev 1 corrected',
    sheetList: 'E0.01',
    issuedAt: '2020-01-01T00:00:00.000Z',
  });
  for (const method of ['PATCH', 'PUT', 'DELETE']) {
    // A DELETE carries no body, and so no content-type either: sending one
    // would be refused for the empty body and never reach the router, which
    // is the thing being asserted about.
    const carries = method !== 'DELETE';
    const response = await app.fetch(`/v1/submissions/${issued.id}`, {
      method,
      ...(carries ? { headers: json, body: edit } : {}),
    });
    // There is no such route, which is what makes this true by construction
    // rather than by a guard that can be forgotten (ADR-0015).
    expect(response.status, method).toBe(404);
  }

  const after = await submission(app, issued.id);
  expect(after.recipient).toBe('Wren Alcott');
  expect(after.revision).toBe('Rev 1');
  expect(after.sheetList).toBe('E0.01\nE1.01');
  expect(after.issuedAt).toBe(issued.issuedAt);
});

test('a reissue body cannot assert what only the moment of issuance decides', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const first = await createSubmission(app, project.id, { phaseId: phase.id });
  const other = await createSubmission(app, project.id, {
    phaseId: phase.id,
    revision: 'Rev 9',
  });

  for (const claim of [
    { issuedProvisional: false },
    { currentlyProvisional: false },
    { supersedesId: other.id },
    { supersededById: other.id },
  ]) {
    const response = await post(app, `/v1/submissions/${first.id}/reissue`, {
      ...submissionBody({ revision: 'Rev 2' }),
      ...claim,
    });
    expect(response.status, JSON.stringify(claim)).toBe(400);
  }

  expect(ids(await submissions(app, project.id))).toEqual([first.id, other.id]);
});

// ── What a reissue may name ───────────────────────────────────────────────

test('reissuing a submission that does not exist is a 404', async () => {
  const app = await api();
  const absent = '00000000-0000-4000-8000-000000000000';

  const response = await post(
    app,
    `/v1/submissions/${absent}/reissue`,
    submissionBody(),
  );
  expect(response.status).toBe(404);
  expect((await response.json()) as { message: string }).toEqual({
    message: 'no submission with that id',
  });
});

test('a reissue may move to another phase of its own project, and to no other', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const permit = await createPhase(app, project.id, 'Building Permit Set');
  const elsewhere = await job(app, 'S-2', 'Harbour depot');

  const first = await createSubmission(app, project.id, { phaseId: phase.id });

  const foreign = await post(
    app,
    `/v1/submissions/${first.id}/reissue`,
    submissionBody({ revision: 'Rev 2', phaseId: elsewhere.phase.id }),
  );
  expect(foreign.status).toBe(409);
  expect((await foreign.json()) as { message: string }).toEqual({
    message: 'that phase belongs to another project',
  });

  const moved = await reissueSubmission(app, first.id, {
    revision: 'Rev 2',
    phaseId: permit.id,
  });
  expect(moved.phaseId).toBe(permit.id);
});

test('a reissue refuses an unknown phase, another project’s open item, and a repeated one', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const elsewhere = await job(app, 'S-2', 'Harbour depot');
  const theirs = await createOpenItem(app, elsewhere.project.id);
  const mine = await createOpenItem(app, project.id);

  const first = await createSubmission(app, project.id, { phaseId: phase.id });
  const absent = '00000000-0000-4000-8000-000000000000';

  const refusals: [Partial<Parameters<typeof submissionBody>[0]>, number, string][] =
    [
      [{ phaseId: absent }, 404, 'no phase with that id'],
      [{ openItemIds: [theirs.id] }, 409, 'that open item is on another project'],
      [{ openItemIds: [absent] }, 404, 'no open item with that id'],
      [
        { openItemIds: [mine.id, mine.id] },
        409,
        'an open item can only be named once on a submission',
      ],
    ];

  for (const [patch, status, message] of refusals) {
    const response = await post(
      app,
      `/v1/submissions/${first.id}/reissue`,
      submissionBody({ revision: 'Rev 2', ...patch }),
    );
    expect(response.status, JSON.stringify(patch)).toBe(status);
    expect((await response.json()) as { message: string }).toEqual({ message });
  }

  // Every one of those was refused before anything was written, so the
  // predecessor is still reissuable.
  expect((await submission(app, first.id)).supersededById).toBeNull();
});
