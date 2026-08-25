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
