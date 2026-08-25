import { afterEach, expect, test } from 'vitest';
import {
  createOpenItem,
  createProject,
  fakeTimeSource,
  openItemBody,
  startTestApi,
  type OpenItemResponse,
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

async function projectItems(app: TestApi, projectId: string, resolved = false) {
  const response = await app.fetch(
    `/v1/projects/${projectId}/open-items?resolved=${resolved}`,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as OpenItemResponse[];
}

async function pending(app: TestApi, query = '') {
  const response = await app.fetch(`/v1/open-items${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as (OpenItemResponse & {
    project: { id: string; projectNumber: string; name: string };
  })[];
}

function resolve(app: TestApi, id: string, body: unknown) {
  return app.fetch(`/v1/open-items/${id}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function reopen(app: TestApi, id: string) {
  return app.fetch(`/v1/open-items/${id}/reopen`, { method: 'POST' });
}

test('an open item created against a project is read back with every field', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Example job');

  const created = await createOpenItem(app, project.id, {
    unresolved: 'Ceiling height at the north stair',
    blocks: 'Sizing the main run',
    waitingOn: 'Contractor',
    waitingSince: '2026-03-01T12:00:00.000Z',
    invalidationTrigger: 'A transformer swap',
    counterfactual: 'If the height is lower the run has to be rerouted',
    owner: 'AV',
  });

  expect(created).toMatchObject({
    subjectType: 'PROJECT',
    subjectId: project.id,
    unresolved: 'Ceiling height at the north stair',
    blocks: 'Sizing the main run',
    waitingOn: 'Contractor',
    waitingSince: '2026-03-01T12:00:00.000Z',
    invalidationTrigger: 'A transformer swap',
    counterfactual: 'If the height is lower the run has to be rerouted',
    owner: 'AV',
    resolvedAt: null,
    resolutionNote: null,
  });
  expect(await projectItems(app, project.id)).toEqual([created]);
});

test('the optional fields come back null when they are not supplied', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Example job');

  const created = await createOpenItem(app, project.id, {
    invalidationTrigger: undefined,
    owner: undefined,
  });

  expect(created).toMatchObject({ invalidationTrigger: null, owner: null });
});

test('nobody owing the next move is a real value, distinct from an empty field', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Example job');

  const nobody = await createOpenItem(app, project.id, { waitingOn: null });
  expect(nobody.waitingOn).toBeNull();

  // An empty field is not "nobody": both the blank string and the missing key
  // are rejected, so nobody can only be said on purpose.
  for (const body of [
    { ...openItemBody(), waitingOn: '' },
    (({ waitingOn: _omitted, ...rest }) => rest)(openItemBody()),
  ]) {
    const response = await app.fetch(
      `/v1/projects/${project.id}/open-items`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    expect(response.status).toBe(400);
  }

  expect(await projectItems(app, project.id)).toEqual([nobody]);
});

test('waiting since defaults to the injected time source and is otherwise honoured', async () => {
  const time = fakeTimeSource(new Date('2026-08-25T09:00:00.000Z'));
  const app = await api({ timeSource: time });
  const project = await createProject(app, 'T-1', 'Example job');

  const now = await createOpenItem(app, project.id, {
    waitingSince: undefined,
  });
  expect(now.waitingSince).toBe('2026-08-25T09:00:00.000Z');

  // Backdating is what makes entering a live project's existing items honest:
  // an item open since March must not read as opened this morning.
  const backdated = await createOpenItem(app, project.id, {
    waitingSince: '2026-03-01T12:00:00.000Z',
  });
  expect(backdated.waitingSince).toBe('2026-03-01T12:00:00.000Z');
});

test('resolving stamps a note and a date, and the item stays on its project', async () => {
  const time = fakeTimeSource(new Date('2026-08-25T09:00:00.000Z'));
  const app = await api({ timeSource: time });
  const project = await createProject(app, 'T-1', 'Example job');
  const item = await createOpenItem(app, project.id);

  time.advance(3 * 24 * 60 * 60 * 1000);
  const response = await resolve(app, item.id, {
    note: 'The party confirmed it',
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    resolvedAt: '2026-08-28T09:00:00.000Z',
    resolutionNote: 'The party confirmed it',
  });

  expect(await projectItems(app, project.id)).toEqual([]);
  const resolved = await projectItems(app, project.id, true);
  expect(resolved.map((entry) => entry.id)).toEqual([item.id]);
});

test('a resolution date may be supplied rather than taken from the clock', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Example job');
  const item = await createOpenItem(app, project.id);

  const response = await resolve(app, item.id, {
    note: 'Answered on site',
    resolvedAt: '2026-04-02T15:30:00.000Z',
  });

  expect(await response.json()).toMatchObject({
    resolvedAt: '2026-04-02T15:30:00.000Z',
  });
});

test('reopening a resolved item clears the resolution and returns it to the view', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Example job');
  const item = await createOpenItem(app, project.id);
  await resolve(app, item.id, { note: 'Answer turned out wrong' });

  const response = await reopen(app, item.id);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    resolvedAt: null,
    resolutionNote: null,
  });

  expect((await projectItems(app, project.id)).map((e) => e.id)).toEqual([
    item.id,
  ]);
  expect(await projectItems(app, project.id, true)).toEqual([]);
});

test('resolving twice, or reopening what is already open, is refused', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Example job');
  const item = await createOpenItem(app, project.id);

  expect((await reopen(app, item.id)).status).toBe(409);

  await resolve(app, item.id, { note: 'First answer' });
  // A silent no-op would drop the second note on the floor.
  const again = await resolve(app, item.id, { note: 'Second answer' });
  expect(again.status).toBe(409);

  expect(
    (await projectItems(app, project.id, true))[0]?.resolutionNote,
  ).toBe('First answer');
});

test('the pending items view spans projects and shows only what is unresolved', async () => {
  const app = await api();
  const one = await createProject(app, 'T-1', 'Example job');
  const two = await createProject(app, 'T-2', 'Service upgrade');

  const first = await createOpenItem(app, one.id, {
    unresolved: 'Ceiling height at the north stair',
    waitingSince: '2026-03-01T12:00:00.000Z',
  });
  const second = await createOpenItem(app, two.id, {
    unresolved: 'Panel B schedule',
    waitingSince: '2026-06-01T12:00:00.000Z',
  });
  const done = await createOpenItem(app, two.id, { unresolved: 'Answered' });
  await resolve(app, done.id, { note: 'Answered' });

  const view = await pending(app);

  // Oldest first: the age is the point of the view.
  expect(view.map((entry) => entry.id)).toEqual([first.id, second.id]);
  expect(view[0]?.project).toMatchObject({
    id: one.id,
    projectNumber: 'T-1',
    name: 'Example job',
  });
  expect(view[1]?.project).toMatchObject({ projectNumber: 'T-2' });
});

test('the pending items view sorts by age in either direction', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Example job');
  const old = await createOpenItem(app, project.id, {
    waitingSince: '2026-03-01T12:00:00.000Z',
  });
  const recent = await createOpenItem(app, project.id, {
    waitingSince: '2026-08-01T12:00:00.000Z',
  });

  expect((await pending(app, '?sort=oldest')).map((e) => e.id)).toEqual([
    old.id,
    recent.id,
  ]);
  expect((await pending(app, '?sort=newest')).map((e) => e.id)).toEqual([
    recent.id,
    old.id,
  ]);
});

test('the pending items view filters by who owes the next move', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Example job');
  const contractor = await createOpenItem(app, project.id, {
    waitingOn: 'Contractor',
  });
  await createOpenItem(app, project.id, { waitingOn: 'Architect' });
  const nobody = await createOpenItem(app, project.id, { waitingOn: null });

  expect(
    (await pending(app, '?waitingOn=Contractor')).map((e) => e.id),
  ).toEqual([contractor.id]);

  // `nobody` is the reserved value for "no one owes the next move", which is
  // the whole reason that state is not spelled as a blank field.
  expect((await pending(app, '?waitingOn=nobody')).map((e) => e.id)).toEqual([
    nobody.id,
  ]);

  // The screens render it capitalised, so typing back what is on screen has
  // to find the same rows rather than searching for a party of that name.
  expect((await pending(app, '?waitingOn=Nobody')).map((e) => e.id)).toEqual([
    nobody.id,
  ]);

  // A blank filter is not a filter for nobody.
  expect((await app.fetch('/v1/open-items?waitingOn=')).status).toBe(400);
  expect((await app.fetch('/v1/open-items?waitingOn=%20%20')).status).toBe(400);
});

test('an open item on an archived project is still pending', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Finished job');
  const item = await createOpenItem(app, project.id);
  await app.fetch(`/v1/projects/${project.id}/archive`, { method: 'POST' });

  expect((await pending(app)).map((entry) => entry.id)).toEqual([item.id]);
});

test('an unknown project or open item is a 404 everywhere it is named', async () => {
  const app = await api();
  const unknown = '00000000-0000-0000-0000-000000000000';

  const created = await app.fetch(`/v1/projects/${unknown}/open-items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(openItemBody()),
  });
  expect(created.status).toBe(404);

  expect(
    (await app.fetch(`/v1/projects/${unknown}/open-items`)).status,
  ).toBe(404);
  expect((await resolve(app, unknown, { note: 'x' })).status).toBe(404);
  expect((await reopen(app, unknown)).status).toBe(404);
});

test.each([
  ['no statement of what is unresolved', { unresolved: undefined }],
  ['an empty statement of what is unresolved', { unresolved: '' }],
  ['nothing it blocks', { blocks: undefined }],
  ['no counterfactual', { counterfactual: undefined }],
  ['an empty counterfactual', { counterfactual: '' }],
  ['an unparseable since-when', { waitingSince: 'last March' }],
  ['an over-long statement', { unresolved: 'x'.repeat(501) }],
  ['an over-long counterfactual', { counterfactual: 'x'.repeat(1001) }],
  ['an over-long party', { waitingOn: 'x'.repeat(121) }],
  ['a party of only whitespace', { waitingOn: '   ' }],
  ['a statement of only whitespace', { unresolved: '   ' }],
  ['a counterfactual of only whitespace', { counterfactual: '  ' }],
  ['an owner of only whitespace', { owner: ' ' }],
])('an open item with %s is rejected and nothing is stored', async (_, patch) => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Example job');

  const response = await app.fetch(`/v1/projects/${project.id}/open-items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(openItemBody(patch)),
  });

  expect(response.status).toBe(400);
  expect(await projectItems(app, project.id)).toEqual([]);
});

test('an open item cannot carry a field the record does not have', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Example job');

  const response = await app.fetch(`/v1/projects/${project.id}/open-items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...openItemBody(), dueDate: '2026-09-01' }),
  });

  expect(response.status).toBe(400);
});

test('resolving without a note is refused', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Example job');
  const item = await createOpenItem(app, project.id);

  expect((await resolve(app, item.id, {})).status).toBe(400);
  expect((await resolve(app, item.id, { note: '' })).status).toBe(400);
  expect((await resolve(app, item.id, { note: '   ' })).status).toBe(400);
  expect((await projectItems(app, project.id)).map((e) => e.id)).toEqual([
    item.id,
  ]);
});
