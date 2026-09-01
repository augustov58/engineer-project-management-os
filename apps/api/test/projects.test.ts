import { afterEach, expect, test } from 'vitest';
import {
  createProject,
  fakeTimeSource,
  startTestApi,
  type TestApi,
} from './harness.js';

const started: TestApi[] = [];

async function api(options?: Parameters<typeof startTestApi>[0]) {
  const instance = await startTestApi(options);
  started.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((instance) => instance.close()));
});

async function listProjects(app: TestApi, archived = false) {
  const response = await app.fetch(`/v1/projects?archived=${archived}`);
  expect(response.status).toBe(200);
  return (await response.json()) as { projectNumber: string }[];
}

test('a project created through the API is read back out of PostgreSQL', async () => {
  const app = await api();

  const created = await createProject(app, 'T-1', 'Riser replacement');

  expect(created).toMatchObject({
    projectNumber: 'T-1',
    name: 'Riser replacement',
    archivedAt: null,
  });
  expect(await listProjects(app)).toEqual([created]);
});

test('every live project appears in the list, in the order they were added', async () => {
  const app = await api();

  // T-10 before T-2 on purpose: sorting the project number as text would
  // reorder these, and the plan fixes no order.
  await createProject(app, 'T-2', 'Second');
  await createProject(app, 'T-10', 'Tenth');
  await createProject(app, 'T-1', 'First');

  expect((await listProjects(app)).map((p) => p.projectNumber)).toEqual([
    'T-2',
    'T-10',
    'T-1',
  ]);
});

test('a project number already in use is rejected and nothing is stored', async () => {
  const app = await api();
  await createProject(app, 'T-1', 'Riser replacement');

  const response = await app.fetch('/v1/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectNumber: 'T-1', name: 'A different job' }),
  });

  expect(response.status).toBe(409);
  expect((await listProjects(app)).map((p) => p.projectNumber)).toEqual(['T-1']);
});

test('the API exposes no route that changes a project after creation', async () => {
  const app = await api();
  const created = await createProject(app, 'T-1', 'Riser replacement');

  for (const method of ['PUT', 'PATCH'] as const) {
    const response = await app.fetch(`/v1/projects/${created.id}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectNumber: 'T-9', name: 'Renamed' }),
    });
    expect(response.status).toBe(404);
  }

  expect(await listProjects(app)).toEqual([created]);
});

test('archiving drops a project from the list without deleting the record', async () => {
  const app = await api();
  const finished = await createProject(app, 'T-1', 'Finished job');
  await createProject(app, 'T-2', 'Live job');

  const archive = await app.fetch(`/v1/projects/${finished.id}/archive`, {
    method: 'POST',
  });
  expect(archive.status).toBe(200);

  expect((await listProjects(app)).map((p) => p.projectNumber)).toEqual(['T-2']);

  const record = await app.fetch(`/v1/projects/${finished.id}`);
  expect(record.status).toBe(200);
  expect(await record.json()).toMatchObject({
    id: finished.id,
    projectNumber: 'T-1',
    name: 'Finished job',
  });

  // Reachable without a memorised URL: the archived half of the list.
  expect((await listProjects(app, true)).map((p) => p.projectNumber)).toEqual([
    'T-1',
  ]);
});

test('archiving stamps the injected time source and never restamps', async () => {
  const time = fakeTimeSource(new Date('2026-03-01T12:00:00.000Z'));
  const app = await api({ timeSource: time });
  const project = await createProject(app, 'T-1', 'Finished job');
  expect(project.createdAt).toBe('2026-03-01T12:00:00.000Z');

  time.advance(90 * 24 * 60 * 60 * 1000);
  const first = await app.fetch(`/v1/projects/${project.id}/archive`, {
    method: 'POST',
  });
  expect(await first.json()).toMatchObject({
    archivedAt: '2026-05-30T12:00:00.000Z',
  });

  time.advance(30 * 24 * 60 * 60 * 1000);
  const again = await app.fetch(`/v1/projects/${project.id}/archive`, {
    method: 'POST',
  });
  expect(again.status).toBe(200);

  const record = await app.fetch(`/v1/projects/${project.id}`);
  expect(await record.json()).toMatchObject({
    archivedAt: '2026-05-30T12:00:00.000Z',
  });
});

test('the time source defaults to the real clock', async () => {
  const app = await api();
  const before = Date.now();

  const created = await createProject(app, 'T-1', 'Riser replacement');

  const stamped = Date.parse(created.createdAt);
  expect(stamped).toBeGreaterThanOrEqual(before);
  expect(stamped).toBeLessThanOrEqual(Date.now());
});

test.each([
  ['no name', { projectNumber: 'T-1' }],
  ['no project number', { name: 'Riser replacement' }],
  ['an empty name', { projectNumber: 'T-1', name: '' }],
  ['a blank project number', { projectNumber: '   ', name: 'Riser' }],
  ['a project number with a space', { projectNumber: 'T 1', name: 'Riser' }],
  ['an unknown field', { projectNumber: 'T-1', name: 'Riser', owner: 'me' }],
  ['an over-long project number', { projectNumber: 'T'.repeat(33), name: 'R' }],
  ['an over-long name', { projectNumber: 'T-1', name: 'R'.repeat(201) }],
])('a project with %s is rejected and nothing is stored', async (_, body) => {
  const app = await api();

  const response = await app.fetch('/v1/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  expect(response.status).toBe(400);
  expect(await listProjects(app)).toEqual([]);
});

test('a project number of exactly 32 characters and a 200-character name are accepted', async () => {
  const app = await api();

  const created = await createProject(app, 'T'.repeat(32), 'R'.repeat(200));

  expect(created.projectNumber).toHaveLength(32);
  expect(created.name).toHaveLength(200);
});

test('an unknown project is a 404 to read and to archive', async () => {
  const app = await api();
  const unknown = '00000000-0000-0000-0000-000000000000';

  expect((await app.fetch(`/v1/projects/${unknown}`)).status).toBe(404);
  expect(
    (await app.fetch(`/v1/projects/${unknown}/archive`, { method: 'POST' }))
      .status,
  ).toBe(404);
});

// ── Processing location (issue #21, stories 91 and 92) ───────────────────────

const SIGNOFF_AT = '2026-08-20T00:00:00.000Z';

async function setProcessingLocation(
  app: TestApi,
  projectId: string,
  body: Record<string, unknown>,
) {
  return app.fetch(`/v1/projects/${projectId}/processing-location`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function auditOn(app: TestApi, projectId: string) {
  const response = await app.fetch(`/v1/projects/${projectId}/memory/audit`);
  expect(response.status).toBe(200);
  return (await response.json()) as { action: string; detail: string }[];
}

test('a new project is on cloud processing with no sign-off recorded', async () => {
  const app = await api();

  const created = await createProject(app, 'T-1', 'Riser replacement');

  // ADR-0013 over the glossary, settled by ADR-0044: the author rejected
  // local-first on operational grounds, and 0013 is the qualifier ADR-0008
  // itself names. A project therefore reaches cloud without being switched
  // and with nothing signed — which is exactly why the pairing CHECK cannot
  // also say "cloud implies a sign-off", and why the route is the only gate.
  expect(created.processingLocation).toBe('CLOUD');
  expect(created.cloudSignoffReference).toBeNull();
  expect(created.cloudSignoffAt).toBeNull();
});

test('switching to local needs nothing at all, and is one line in the audit', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Riser replacement');

  const response = await setProcessingLocation(app, project.id, {
    location: 'LOCAL',
  });

  expect(response.status).toBe(200);
  const updated = (await response.json()) as typeof project;
  expect(updated.processingLocation).toBe('LOCAL');
  // Consent can be withdrawn, so nothing may stand between the engineer and
  // stopping the sending. The asymmetry with the switch below is the point.
  expect(await auditOn(app, project.id)).toEqual([
    expect.objectContaining({
      action: 'processing location set to local',
      detail: 'no sign-off had been recorded',
    }),
  ]);
});

test('switching to cloud without the sign-off reference and date is refused', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Riser replacement');
  expect(
    (await setProcessingLocation(app, project.id, { location: 'LOCAL' })).status,
  ).toBe(200);

  const neither = await setProcessingLocation(app, project.id, {
    location: 'CLOUD',
  });
  expect(neither.status).toBe(400);
  expect(await neither.json()).toEqual({
    message:
      'switching to cloud processing needs the written sign-off reference and its date',
  });

  // One half is not the record story 92 asks for either.
  const halfOf = await setProcessingLocation(app, project.id, {
    location: 'CLOUD',
    signoffReference: 'DPA-2026-014',
  });
  expect(halfOf.status).toBe(400);

  // Nothing moved.
  const read = await app.fetch(`/v1/projects/${project.id}`);
  expect(((await read.json()) as typeof project).processingLocation).toBe(
    'LOCAL',
  );
  expect(await auditOn(app, project.id)).toHaveLength(1);
});

test('a written sign-off switches a project to cloud and is visible on it', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Riser replacement');
  await setProcessingLocation(app, project.id, { location: 'LOCAL' });

  const response = await setProcessingLocation(app, project.id, {
    location: 'CLOUD',
    signoffReference: 'DPA-2026-014',
    signoffAt: SIGNOFF_AT,
  });

  expect(response.status).toBe(200);
  const updated = (await response.json()) as typeof project;
  expect(updated.processingLocation).toBe('CLOUD');
  expect(updated.cloudSignoffReference).toBe('DPA-2026-014');
  // Supplied and never read off the TimeSource, the frame `heldSince` uses: a
  // letter signed on the 20th and recorded today is dated the 20th.
  expect(updated.cloudSignoffAt).toBe(SIGNOFF_AT);
});

test('the first sign-off on a project nobody switched is not a second one', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Riser replacement');

  // Already CLOUD, by default and never having been switched. Recording the
  // firm's sign-off against it must work, or a default-cloud project could
  // never carry one and story 92 would be unreachable on every real job.
  const response = await setProcessingLocation(app, project.id, {
    location: 'CLOUD',
    signoffReference: 'DPA-2026-014',
    signoffAt: SIGNOFF_AT,
  });

  expect(response.status).toBe(200);
  expect(((await response.json()) as typeof project).cloudSignoffReference).toBe(
    'DPA-2026-014',
  );
});

test('a second sign-off is refused rather than overwriting the first', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Riser replacement');
  await setProcessingLocation(app, project.id, {
    location: 'CLOUD',
    signoffReference: 'DPA-2026-014',
    signoffAt: SIGNOFF_AT,
  });

  const again = await setProcessingLocation(app, project.id, {
    location: 'CLOUD',
    signoffReference: 'DPA-2026-099',
    signoffAt: '2026-08-30T00:00:00.000Z',
  });

  // What the firm agreed to is not a last-write-wins field — a response, a
  // disposition and a referenced-file marking all refuse the second the
  // same way.
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({
    message: 'a written sign-off is already recorded on this project',
  });
  const read = await app.fetch(`/v1/projects/${project.id}`);
  expect(((await read.json()) as typeof project).cloudSignoffReference).toBe(
    'DPA-2026-014',
  );
});

test('a sign-off offered to a switch to local is refused, not ignored', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Riser replacement');

  const response = await setProcessingLocation(app, project.id, {
    location: 'LOCAL',
    signoffReference: 'DPA-2026-014',
    signoffAt: SIGNOFF_AT,
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    message: 'switching to local processing records no sign-off',
  });
});

test('switching a project to local when it is already local is refused', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Riser replacement');
  await setProcessingLocation(app, project.id, { location: 'LOCAL' });

  const again = await setProcessingLocation(app, project.id, {
    location: 'LOCAL',
  });

  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({
    message: 'this project is already set to local processing',
  });
  expect(await auditOn(app, project.id)).toHaveLength(1);
});

test('going back to local clears the sign-off, and the audit is what keeps it', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Riser replacement');
  await setProcessingLocation(app, project.id, {
    location: 'CLOUD',
    signoffReference: 'DPA-2026-014',
    signoffAt: SIGNOFF_AT,
  });

  const response = await setProcessingLocation(app, project.id, {
    location: 'LOCAL',
  });

  expect(response.status).toBe(200);
  const updated = (await response.json()) as typeof project;
  // Cleared, so returning to cloud needs a fresh sign-off — consent given
  // once is not consent standing forever.
  expect(updated.cloudSignoffReference).toBeNull();
  expect(updated.cloudSignoffAt).toBeNull();

  // And the reference survives, which is the only reason clearing is safe.
  // The audit is append-only: nothing updates or deletes a row in it.
  expect(await auditOn(app, project.id)).toEqual([
    expect.objectContaining({
      action: 'processing location set to cloud',
      detail: `the firm signed off in writing on ${SIGNOFF_AT}, reference DPA-2026-014`,
    }),
    expect.objectContaining({
      action: 'processing location set to local',
      detail: 'the recorded sign-off DPA-2026-014 was cleared',
    }),
  ]);
});

test('the processing location of an unknown project is a 404', async () => {
  const app = await api();

  const response = await setProcessingLocation(
    app,
    '00000000-0000-0000-0000-000000000000',
    { location: 'LOCAL' },
  );

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ message: 'no project with that id' });
});

test('two sign-offs racing settle as one, and the loser overwrites nothing', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Riser replacement');

  // Twenty at once, as the ingest limit's test fires twenty. What this pins is
  // the outcome: however many arrive together, exactly one sign-off is
  // recorded and the audit says so once — the one column on a project that
  // must never be last-write-wins.
  //
  // It does NOT isolate the compare-and-set in the route. That write is
  // narrowed to `cloudSignoffReference: null` on ADR-0042's reasoning — that
  // reading and writing are two statements, so the read alone is not a bound —
  // but this harness could not be made to lose the race: removing the
  // narrowing leaves this test green, because the handlers never interleave
  // between their read and their write. The narrowing is kept as the archive
  // route above keeps its own, and is unproven by this suite.
  const sent = await Promise.all(
    Array.from({ length: 20 }, (_, n) =>
      setProcessingLocation(app, project.id, {
        location: 'CLOUD',
        signoffReference: `DPA-2026-${String(n).padStart(3, '0')}`,
        signoffAt: SIGNOFF_AT,
      }),
    ),
  );

  expect(sent.filter((one) => one.status === 200)).toHaveLength(1);
  expect(sent.filter((one) => one.status === 409)).toHaveLength(19);

  // Exactly one sign-off stands, and it is one of the two that were sent —
  // never a mix of one request's reference and the other's date.
  const read = await app.fetch(`/v1/projects/${project.id}`);
  const settled = (await read.json()) as typeof project;
  expect(settled.processingLocation).toBe('CLOUD');
  expect(settled.cloudSignoffReference).toMatch(/^DPA-2026-\d{3}$/);
  expect(settled.cloudSignoffAt).toBe(SIGNOFF_AT);

  // And the audit records one change, not two.
  expect(await auditOn(app, project.id)).toHaveLength(1);
});
