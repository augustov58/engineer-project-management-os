import { afterEach, expect, test } from 'vitest';
import {
  createOpenItem,
  createPhase,
  createProject,
  createSubmission,
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

/** The exposure view, across every project or narrowed to one. */
async function exposure(app: TestApi, projectId?: string) {
  const path =
    projectId === undefined ? '/v1/exposure' : `/v1/exposure?projectId=${projectId}`;
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

// ── Provisional is two facts, not one ─────────────────────────────────────

test('a set issued on nothing unresolved is provisional in neither sense', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');

  const issued = await createSubmission(app, project.id, { phaseId: phase.id });
  expect(issued.issuedProvisional).toBe(false);
  expect(issued.currentlyProvisional).toBe(false);

  const detail = await submission(app, issued.id);
  expect(detail.issuedProvisional).toBe(false);
  expect(detail.currentlyProvisional).toBe(false);
});

test('a set issued on an unconfirmed input is stamped provisional, item by item', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const unconfirmed = await createOpenItem(app, project.id);
  const answered = await createOpenItem(app, project.id, {
    unresolved: 'Panel schedule not returned',
  });
  await resolve(app, answered.id);

  const issued = await createSubmission(app, project.id, {
    phaseId: phase.id,
    openItemIds: [unconfirmed.id, answered.id],
  });
  expect(issued.issuedProvisional).toBe(true);
  expect(issued.currentlyProvisional).toBe(true);

  // The snapshot is per item: where each one stood at that moment, not just
  // whether any of them was unresolved.
  const detail = await submission(app, issued.id);
  const stamped = new Map(
    detail.openItems.map((row) => [row.id, row.unresolvedAtIssuance]),
  );
  expect(stamped.get(unconfirmed.id)).toBe(true);
  expect(stamped.get(answered.id)).toBe(false);
});

test('a set that rested only on an already-answered item did not go out provisional', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const answered = await createOpenItem(app, project.id);
  await resolve(app, answered.id);

  const issued = await createSubmission(app, project.id, {
    phaseId: phase.id,
    openItemIds: [answered.id],
  });
  expect(issued.issuedProvisional).toBe(false);
  expect(issued.currentlyProvisional).toBe(false);
});

test('a set issued provisionally and later fully resolved keeps the historical fact', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const first = await createOpenItem(app, project.id);
  const second = await createOpenItem(app, project.id, {
    unresolved: 'Panel schedule not returned',
  });

  const issued = await createSubmission(app, project.id, {
    phaseId: phase.id,
    openItemIds: [first.id, second.id],
  });
  expect(issued.issuedProvisional).toBe(true);

  await resolve(app, first.id);
  await resolve(app, second.id);

  // The permanent record that the set went out on unconfirmed inputs, and the
  // derived state that nothing is unconfirmed now. Cleanup must not erase the
  // first, which is the whole reason provisional is two facts.
  const detail = await submission(app, issued.id);
  expect(detail.issuedProvisional).toBe(true);
  expect(detail.currentlyProvisional).toBe(false);
  expect(detail.openItems.map((row) => row.unresolvedAtIssuance)).toEqual([
    true,
    true,
  ]);
  expect(await exposure(app)).toEqual([]);
});

test('reopening an item a set rested on makes the set currently provisional again', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const item = await createOpenItem(app, project.id);
  const issued = await createSubmission(app, project.id, {
    phaseId: phase.id,
    openItemIds: [item.id],
  });

  await resolve(app, item.id);
  expect((await submission(app, issued.id)).currentlyProvisional).toBe(false);

  expect((await post(app, `/v1/open-items/${item.id}/reopen`)).status).toBe(200);
  // Derived on every read, so an answer that turned out wrong puts the set
  // back into exposure without anything being restamped.
  expect((await submission(app, issued.id)).currentlyProvisional).toBe(true);
  expect((await exposure(app)).map((row) => row.id)).toEqual([issued.id]);
});

test('an item attached after issuance is no part of the snapshot and does not restamp it', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const issued = await createSubmission(app, project.id, { phaseId: phase.id });
  const late = await createOpenItem(app, project.id);

  expect(
    (await post(app, `/v1/submissions/${issued.id}/open-items/${late.id}`))
      .status,
  ).toBe(204);

  const detail = await submission(app, issued.id);
  // The set did go out clean, and no later attachment can claim otherwise.
  expect(detail.issuedProvisional).toBe(false);
  // What is true right now is a different fact, and it did change.
  expect(detail.currentlyProvisional).toBe(true);
  expect(detail.openItems[0]!.unresolvedAtIssuance).toBeNull();
});

test('an item raised against a submission is attached but outside its snapshot', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const issued = await createSubmission(app, project.id, { phaseId: phase.id });

  const raised = await post(app, `/v1/submissions/${issued.id}/open-items`, {
    unresolved: 'Ceiling height at the north stair',
    blocks: 'Sizing the main run',
    waitingOn: 'Contractor',
    counterfactual: 'If the height is lower the run has to be rerouted',
  });
  expect(raised.status).toBe(201);

  const detail = await submission(app, issued.id);
  expect(detail.issuedProvisional).toBe(false);
  expect(detail.currentlyProvisional).toBe(true);
  expect(detail.openItems[0]!.unresolvedAtIssuance).toBeNull();
});

// ── Detaching cannot erase the snapshot ───────────────────────────────────

test('what an issuance rested on cannot be detached; what was attached after it can', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const restedOn = await createOpenItem(app, project.id);
  const issued = await createSubmission(app, project.id, {
    phaseId: phase.id,
    openItemIds: [restedOn.id],
  });
  const late = await createOpenItem(app, project.id, {
    unresolved: 'Panel schedule not returned',
  });
  await post(app, `/v1/submissions/${issued.id}/open-items/${late.id}`);

  // Deleting the join row would delete the snapshot with it, which is the
  // erasure by cleanup the record exists to prevent (ADR-0026).
  const refused = await app.fetch(
    `/v1/submissions/${issued.id}/open-items/${restedOn.id}`,
    { method: 'DELETE' },
  );
  expect(refused.status).toBe(409);
  expect((await refused.json()) as { message: string }).toEqual({
    message: 'this submission was issued resting on that open item',
  });

  // An item attached afterwards is a typo, and stays removable.
  const removed = await app.fetch(
    `/v1/submissions/${issued.id}/open-items/${late.id}`,
    { method: 'DELETE' },
  );
  expect(removed.status).toBe(204);

  const detail = await submission(app, issued.id);
  expect(detail.openItems.map((row) => row.id)).toEqual([restedOn.id]);
});

// ── Exposure ──────────────────────────────────────────────────────────────

test('exposure is the issued submissions currently carrying unresolved items', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const item = await createOpenItem(app, project.id);

  const provisional = await createSubmission(app, project.id, {
    phaseId: phase.id,
    openItemIds: [item.id],
  });
  const clean = await createSubmission(app, project.id, {
    phaseId: phase.id,
    revision: 'Rev 2',
  });

  const counted = await exposure(app, project.id);
  expect(counted.map((row) => row.id)).toEqual([provisional.id]);
  expect(counted).toHaveLength(1);

  // The chronicle still holds both, so the count is a filter over it rather
  // than a second list that can drift from it.
  expect((await submissions(app, project.id)).map((row) => row.id)).toEqual([
    provisional.id,
    clean.id,
  ]);

  // Resolving the last unconfirmed input takes the set out of exposure.
  await resolve(app, item.id);
  expect(await exposure(app, project.id)).toEqual([]);
});

test('exposure across every project names the job each set belongs to', async () => {
  const app = await api();
  const one = await job(app, 'S-1', 'Riverside clinic');
  const two = await job(app, 'S-2', 'Harbour depot');
  const clinic = await createOpenItem(app, one.project.id);
  const depot = await createOpenItem(app, two.project.id);

  const first = await createSubmission(app, one.project.id, {
    phaseId: one.phase.id,
    openItemIds: [clinic.id],
  });
  const second = await createSubmission(app, two.project.id, {
    phaseId: two.phase.id,
    openItemIds: [depot.id],
  });
  await createSubmission(app, one.project.id, {
    phaseId: one.phase.id,
    revision: 'Rev 2',
  });

  const across = await exposure(app);
  expect(across.map((row) => row.id).sort()).toEqual(
    [first.id, second.id].sort(),
  );
  // Landing on the count has to be enough to act on it: which job, at what
  // phase, and what went out.
  const clinicRow = across.find((row) => row.id === first.id)!;
  expect(clinicRow.project.projectNumber).toBe('S-1');
  expect(clinicRow.phase.name).toBe('90% CD');
  expect(clinicRow.revision).toBe('Rev 1');

  // Narrowing to one job is the same query, so the number on a project screen
  // and the rows it lands on cannot disagree.
  expect((await exposure(app, one.project.id)).map((row) => row.id)).toEqual([
    first.id,
  ]);
});

test('an archived project drops out of exposure but keeps its own count', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const item = await createOpenItem(app, project.id);
  const issued = await createSubmission(app, project.id, {
    phaseId: phase.id,
    openItemIds: [item.id],
  });

  expect((await exposure(app)).map((row) => row.id)).toEqual([issued.id]);

  expect((await post(app, `/v1/projects/${project.id}/archive`)).status).toBe(
    200,
  );

  // Exposure is one of the two daily counts, and a finished job is not part
  // of today's work (glossary, **Pending items**).
  expect(await exposure(app)).toEqual([]);
  // Asked about that job directly, the record still says what it says.
  expect((await exposure(app, project.id)).map((row) => row.id)).toEqual([
    issued.id,
  ]);
});

test('exposure is a count and nothing else — no score, ratio or percentage', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const item = await createOpenItem(app, project.id);
  await createSubmission(app, project.id, {
    phaseId: phase.id,
    openItemIds: [item.id],
  });

  // ADR-0016 supersedes the health score: the number is a list of records you
  // can act on, never a figure derived by combining it with another.
  const response = await app.fetch('/v1/exposure');
  const body = (await response.json()) as unknown;
  expect(Array.isArray(body)).toBe(true);

  const combined = /score|ratio|percent|health|index|rating/i;
  const fields = Object.keys((body as ExposureRow[])[0]!);
  expect(fields.filter((field) => combined.test(field))).toEqual([]);
});

test('an unknown project asked for its exposure is a 404, not an empty count', async () => {
  const app = await api();
  const absent = '00000000-0000-4000-8000-000000000000';

  const response = await app.fetch(`/v1/exposure?projectId=${absent}`);
  expect(response.status).toBe(404);
  // Nothing to act on and no such job read the same as a number; they are
  // not the same answer.
  expect((await response.json()) as { message: string }).toEqual({
    message: 'no project with that id',
  });
});

test('a submission body cannot claim a set went out clean when it did not', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'S-1', 'Riverside clinic');
  const item = await createOpenItem(app, project.id);

  for (const claim of [
    { issuedProvisional: false },
    { currentlyProvisional: false },
  ]) {
    const response = await post(
      app,
      `/v1/projects/${project.id}/submissions`,
      { ...submissionBody({ phaseId: phase.id, openItemIds: [item.id] }), ...claim },
    );
    expect(response.status, JSON.stringify(claim)).toBe(400);
  }

  expect(await submissions(app, project.id)).toEqual([]);
});
