import { afterEach, expect, test } from 'vitest';
import {
  createIssue,
  createObservation,
  createOpenItem,
  createProject,
  createSiteVisit,
  fakeTimeSource,
  startTestApi,
  type IssueResponse,
  type ObservationResponse,
  type OpenItemResponse,
  type ProjectResponse,
  type SiteVisitResponse,
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

const NO_SUCH = '2f1e6d8c-0000-4000-8000-000000000000';

/** The five, in the words the glossary writes them. */
const CATEGORIES = [
  'Accessibility',
  'Physical / Safety',
  'Functional',
  'Safety / Code',
  'Design / Coordination',
];

async function issues(app: TestApi, projectId: string) {
  const response = await app.fetch(`/v1/projects/${projectId}/issues`);
  expect(response.status).toBe(200);
  return (await response.json()) as IssueResponse[];
}

/** Resolving the stable identifier, which is the point of having one. */
async function issue(app: TestApi, projectId: string, number: number) {
  const response = await app.fetch(
    `/v1/projects/${projectId}/issues/${number}`,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as IssueResponse;
}

function raise(app: TestApi, observationId: string, category: string) {
  return post(app, `/v1/observations/${observationId}/issue`, { category });
}

function reobserve(app: TestApi, issueId: string, observationId: string) {
  return post(app, `/v1/issues/${issueId}/observations/${observationId}`);
}

function closeIssue(app: TestApi, id: string, body: unknown) {
  return post(app, `/v1/issues/${id}/close`, body);
}

function reopenIssue(app: TestApi, id: string) {
  return post(app, `/v1/issues/${id}/reopen`);
}

async function pending(app: TestApi) {
  const response = await app.fetch('/v1/open-items');
  expect(response.status).toBe(200);
  return (await response.json()) as (OpenItemResponse & {
    project: { id: string; projectNumber: string; name: string } | null;
  })[];
}

/**
 * A job, a walk, and something seen on it — the fixture every test here needs,
 * because an issue is only ever raised from an observation.
 */
async function seen(
  app: TestApi,
  projectNumber: string,
  name: string,
  patch: Parameters<typeof createObservation>[2] = {},
): Promise<{
  project: ProjectResponse;
  walk: SiteVisitResponse;
  observation: ObservationResponse;
}> {
  const project = await createProject(app, projectNumber, name);
  const walk = await createSiteVisit(app, project.id, {
    startedAt: '2026-07-23T13:00:00.000Z',
  });
  const observation = await createObservation(app, walk.id, patch);
  return { project, walk, observation };
}

// ── An observation becomes an issue (story 57) ─────────────────────────────

test('an observation becomes an issue with a category and an identifier', async () => {
  const app = await api();
  const { project, observation } = await seen(app, 'I-1', 'Riverside clinic');

  const response = await raise(app, observation.id, 'Physical / Safety');

  expect(response.status).toBe(201);
  const raised = (await response.json()) as IssueResponse;
  expect(raised).toMatchObject({
    projectId: project.id,
    number: 1,
    category: 'Physical / Safety',
    closedAt: null,
    closureNote: null,
  });
  expect(raised.observations.map((row) => row.id)).toEqual([observation.id]);
  expect(await issues(app, project.id)).toEqual([raised]);
});

test('an issue owns no content of its own — the sighting is the observation', async () => {
  const app = await api();
  const { project, walk, observation } = await seen(app, 'I-2', 'No content');

  const raised = await createIssue(app, observation.id);

  // What was seen, when and where belongs to the observation, and an issue
  // re-observed on three walks has three of them. There is no summary column
  // here, and no location — the PRD's sketch named one; it is read through.
  expect(Object.keys(raised).sort()).toEqual([
    'category',
    'closedAt',
    'closureNote',
    'createdAt',
    'id',
    'number',
    'observations',
    'openItems',
    'projectId',
  ]);

  const sighting = raised.observations[0];
  expect(sighting?.observed).toBe(observation.observed);
  expect(sighting?.location).toBe('Floor 3 — Stair B, Side A');
  expect(sighting?.siteVisit).toEqual({
    id: walk.id,
    startedAt: walk.startedAt,
    endedAt: null,
    visitedOn: '2026-07-23',
  });
  expect(raised.projectId).toBe(project.id);
});

test.each(CATEGORIES)('%s is one of the five', async (category) => {
  const app = await api();
  const { observation } = await seen(app, `C-${category.length}`, 'Five');

  const response = await raise(app, observation.id, category);

  expect(response.status).toBe(201);
  expect(((await response.json()) as IssueResponse).category).toBe(category);
});

test.each([
  ['a sixth value', 'Electrical'],
  ['the glossary spelling without its spaces', 'Physical/Safety'],
  ['a struck word', 'Defect'],
  ['the wrong case', 'accessibility'],
  ['nothing at all', ''],
])('a category that is %s is refused', async (_why, category) => {
  const app = await api();
  const { project, observation } = await seen(app, `X-${category.length}`, 'Closed set');

  expect((await raise(app, observation.id, category)).status).toBe(400);
  expect(await issues(app, project.id)).toHaveLength(0);
});

test('an issue against an observation that does not exist is a 404', async () => {
  const app = await api();

  const response = await raise(app, NO_SUCH, 'Functional');

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    message: 'no observation with that id',
  });
});

test('the same observation cannot become two issues, and the refusal spends no identifier', async () => {
  const app = await api();
  const { project, walk, observation } = await seen(app, 'I-3', 'Once only');

  await createIssue(app, observation.id, 'Accessibility');

  const again = await raise(app, observation.id, 'Functional');
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({
    message: 'that observation is already an issue',
  });

  // The refused promotion rolled back whole, so the next identifier is 2 and
  // not 3 — a number burned on a duplicate could never be given back.
  const other = await createObservation(app, walk.id, {
    observed: 'Conduit support missing at the transformer',
  });
  expect((await createIssue(app, other.id)).number).toBe(2);
  expect((await issues(app, project.id)).map((row) => row.number)).toEqual([
    1, 2,
  ]);
});

// ── The identifier is per project, and never reused (stories 58, 59) ───────

test('identifiers count up within a project and start again on another job', async () => {
  const app = await api();
  const one = await seen(app, 'I-4', 'First job');
  const two = await seen(app, 'I-5', 'Second job');

  expect((await createIssue(app, one.observation.id)).number).toBe(1);
  const alsoOne = await createObservation(app, one.walk.id, {
    observed: 'Ceiling tile displaced',
  });
  expect((await createIssue(app, alsoOne.id)).number).toBe(2);

  // The sequence is the project's own, so a second job starts at one.
  expect((await createIssue(app, two.observation.id)).number).toBe(1);
});

test('closing an issue does not free its identifier', async () => {
  const app = await api();
  const { walk, observation } = await seen(app, 'I-6', 'Never reused');

  const first = await createIssue(app, observation.id);
  const second = await createIssue(
    app,
    (await createObservation(app, walk.id, { observed: 'Second finding' })).id,
  );
  expect([first.number, second.number]).toEqual([1, 2]);

  expect(
    (await closeIssue(app, first.id, { note: 'Sealed by the GC' })).status,
  ).toBe(200);

  // A reference printed in an issued report stays valid forever, so the next
  // issue takes the next number and not the one that just closed.
  const third = await createIssue(
    app,
    (await createObservation(app, walk.id, { observed: 'Third finding' })).id,
  );
  expect(third.number).toBe(3);
});

test('an identifier that was never allocated is a 404', async () => {
  const app = await api();
  const { project, observation } = await seen(app, 'I-7', 'Not yet');
  await createIssue(app, observation.id);

  const response = await app.fetch(`/v1/projects/${project.id}/issues/2`);

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    message: 'no issue with that number on this project',
  });
});

test('an identifier resolves only against the job it was allocated on', async () => {
  const app = await api();
  const mine = await seen(app, 'I-8', 'Mine');
  const theirs = await seen(app, 'I-8b', 'Theirs');

  const raised = await createIssue(app, mine.observation.id);
  expect(raised.number).toBe(1);

  // Numbering restarts per project, so "issue 1" is only ever an answer with
  // a job beside it.
  expect(
    (await app.fetch(`/v1/projects/${theirs.project.id}/issues/1`)).status,
  ).toBe(404);
});

test.each(['PATCH', 'PUT', 'DELETE'])(
  'nothing renumbers an issue: %s is refused',
  async (method) => {
    const app = await api();
    const { project, observation } = await seen(app, `M-${method}`, 'Fixed');
    const raised = await createIssue(app, observation.id, 'Design / Coordination');

    // A DELETE carries no body, and so no content-type either: sending one
    // would be refused for the empty body and never reach the router, which is
    // the thing being asserted about.
    const carries = method !== 'DELETE';
    const response = await app.fetch(`/v1/issues/${raised.id}`, {
      method,
      ...(carries ? { headers: json, body: JSON.stringify({ number: 9 }) } : {}),
    });
    // There is no such route, which is what makes "never renumbered" true by
    // construction rather than by a guard that can be forgotten.
    expect(response.status, method).toBe(404);

    expect(await issue(app, project.id, 1)).toEqual(raised);
  },
);

// ── Still there on the second walk (story 61) ──────────────────────────────

test('an identifier allocated on one visit still resolves after a later visit', async () => {
  const time = fakeTimeSource(new Date('2026-07-23T13:00:00.000Z'));
  const app = await api({ timeSource: time });
  const project = await createProject(app, 'I-9', 'Two walks');

  const july = await createSiteVisit(app, project.id, {
    startedAt: '2026-07-23T13:00:00.000Z',
  });
  const first = await createObservation(app, july.id, {
    observed: 'Fire-rated wall penetration left unsealed above the ceiling',
    observedAt: '2026-07-23T13:40:00.000Z',
  });
  const raised = await createIssue(app, first.id, 'Safety / Code');
  expect(raised.number).toBe(1);

  // A month later, a different walk, the same thing still there.
  time.advance(31 * 24 * 60 * 60 * 1000);
  const august = await createSiteVisit(app, project.id, {
    startedAt: '2026-08-23T09:00:00.000Z',
  });
  const again = await createObservation(app, august.id, {
    observed: 'Penetration still unsealed',
    observedAt: '2026-08-23T09:30:00.000Z',
  });

  expect((await reobserve(app, raised.id, again.id)).status).toBe(204);

  // The identifier allocated on the July walk resolves after the August one,
  // and the two sightings across the two visits are the whole history.
  const resolved = await issue(app, project.id, 1);
  expect(resolved.id).toBe(raised.id);
  expect(resolved.observations.map((row) => row.observed)).toEqual([
    'Fire-rated wall penetration left unsealed above the ceiling',
    'Penetration still unsealed',
  ]);
  expect(resolved.observations.map((row) => row.siteVisit.id)).toEqual([
    july.id,
    august.id,
  ]);
  expect(resolved.observations.map((row) => row.siteVisit.visitedOn)).toEqual([
    '2026-07-23',
    '2026-08-23',
  ]);
});

test('re-observing with the same observation twice is refused', async () => {
  const app = await api();
  const { walk, observation } = await seen(app, 'I-10', 'Twice');
  const raised = await createIssue(app, observation.id);
  const later = await createObservation(app, walk.id, {
    observed: 'Still there',
  });

  expect((await reobserve(app, raised.id, later.id)).status).toBe(204);

  const again = await reobserve(app, raised.id, later.id);
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({
    message: 'that observation is already on this issue',
  });
  expect((await issue(app, raised.projectId, 1)).observations).toHaveLength(2);
});

test('an observation already on another issue cannot be re-observed onto this one', async () => {
  const app = await api();
  const { walk, observation } = await seen(app, 'I-11', 'One finding each');
  const mine = await createIssue(app, observation.id);
  const other = await createObservation(app, walk.id, {
    observed: 'A different problem entirely',
  });
  await createIssue(app, other.id, 'Functional');

  // Two problems seen in one place are two observations, not one observation
  // on two findings.
  const response = await reobserve(app, mine.id, other.id);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    message: 'that observation is already on another issue',
  });
});

test('an observation from another job cannot be re-observed onto this issue', async () => {
  const app = await api();
  const mine = await seen(app, 'I-12', 'Mine');
  const theirs = await seen(app, 'I-12b', 'Theirs');
  const raised = await createIssue(app, mine.observation.id);

  const response = await reobserve(app, raised.id, theirs.observation.id);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    message: 'that observation is on another project',
  });
});

test.each([
  ['issue', (ids: { issue: string; observation: string }) => [NO_SUCH, ids.observation], 'no issue with that id'],
  ['observation', (ids: { issue: string; observation: string }) => [ids.issue, NO_SUCH], 'no observation with that id'],
])('re-observing against a %s that does not exist is a 404', async (_what, pick, message) => {
  const app = await api();
  const { walk, observation } = await seen(app, `R-${message.length}`, 'Missing');
  const raised = await createIssue(app, observation.id);
  const later = await createObservation(app, walk.id, { observed: 'Later' });

  const [issueId, observationId] = pick({
    issue: raised.id,
    observation: later.id,
  });

  const response = await reobserve(app, issueId ?? '', observationId ?? '');
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ message });
});

// ── The lifecycle the five findings never had (story 62) ───────────────────

test('an issue is closed with a date and a note, and reopened if it recurs', async () => {
  const app = await api();
  const { project, observation } = await seen(app, 'I-13', 'Lifecycle');
  const raised = await createIssue(app, observation.id);

  const closed = await closeIssue(app, raised.id, {
    note: 'Sealed and photographed on the return walk',
    closedAt: '2026-08-23T10:00:00.000Z',
  });
  expect(closed.status).toBe(200);
  expect((await closed.json()) as IssueResponse).toMatchObject({
    closedAt: '2026-08-23T10:00:00.000Z',
    closureNote: 'Sealed and photographed on the return walk',
  });

  const reopened = await reopenIssue(app, raised.id);
  expect(reopened.status).toBe(200);
  // Both move together: reopening clears the note with the date, so a stale
  // reason cannot sit on an open finding (ADR-0024's shape).
  expect((await reopened.json()) as IssueResponse).toMatchObject({
    closedAt: null,
    closureNote: null,
  });
  expect(await issue(app, project.id, 1)).toMatchObject({
    closedAt: null,
    closureNote: null,
  });
});

test('the closing date falls back to the injected clock', async () => {
  const time = fakeTimeSource(new Date('2026-08-23T10:00:00.000Z'));
  const app = await api({ timeSource: time });
  const { observation } = await seen(app, 'I-14', 'Clock');
  const raised = await createIssue(app, observation.id);

  const closed = await closeIssue(app, raised.id, { note: 'Done' });

  expect(((await closed.json()) as IssueResponse).closedAt).toBe(
    '2026-08-23T10:00:00.000Z',
  );
});

test('closing an issue twice is refused rather than restamped', async () => {
  const app = await api();
  const { project, observation } = await seen(app, 'I-15', 'Closed once');
  const raised = await createIssue(app, observation.id);

  await closeIssue(app, raised.id, {
    note: 'Sealed by the GC',
    closedAt: '2026-08-23T10:00:00.000Z',
  });

  const again = await closeIssue(app, raised.id, {
    note: 'Something else entirely',
    closedAt: '2026-09-01T10:00:00.000Z',
  });
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({
    message: 'that issue is already closed',
  });

  // Refused, and the reason it was closed the first time still stands.
  expect(await issue(app, project.id, 1)).toMatchObject({
    closedAt: '2026-08-23T10:00:00.000Z',
    closureNote: 'Sealed by the GC',
  });
});

test('reopening an issue that is not closed is refused', async () => {
  const app = await api();
  const { observation } = await seen(app, 'I-16', 'Still open');
  const raised = await createIssue(app, observation.id);

  const response = await reopenIssue(app, raised.id);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    message: 'that issue is not closed',
  });
});

test('closing without a note is refused rather than stored', async () => {
  const app = await api();
  const { project, observation } = await seen(app, 'I-17', 'No note');
  const raised = await createIssue(app, observation.id);

  for (const body of [{}, { note: '   ' }]) {
    expect((await closeIssue(app, raised.id, body)).status).toBe(400);
  }
  expect((await issue(app, project.id, 1)).closedAt).toBeNull();
});

test.each([
  ['close', (app: TestApi) => closeIssue(app, NO_SUCH, { note: 'x' })],
  ['reopen', (app: TestApi) => reopenIssue(app, NO_SUCH)],
])('%s against an issue that does not exist is a 404', async (_what, call) => {
  const app = await api();

  const response = await call(app);
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ message: 'no issue with that id' });
});

// ── An open item chased for a finding (story 69) ───────────────────────────

test('an open item raised on an issue is on the job and in the pending items view', async () => {
  const app = await api();
  const { project, observation } = await seen(app, 'I-18', 'Blocked finding');
  const raised = await createIssue(app, observation.id);

  const response = await post(app, `/v1/issues/${raised.id}/open-items`, {
    unresolved: 'Sealant specification for the rated wall',
    blocks: 'Closing the finding',
    waitingOn: 'General contractor',
    counterfactual: 'If the spec is intumescent the detail has to be redrawn',
  });
  expect(response.status).toBe(201);
  const item = (await response.json()) as OpenItemResponse;

  // The subject stays the job, so the item is on the project screen and
  // reaches the pending items view carrying the job it is on.
  expect(item).toMatchObject({ subjectType: 'PROJECT', subjectId: project.id });
  expect((await pending(app)).map((row) => row.id)).toEqual([item.id]);
  expect((await pending(app))[0]?.project?.projectNumber).toBe('I-18');

  expect((await issue(app, project.id, 1)).openItems).toEqual([item]);
});

test('an open item already on the job attaches to a finding', async () => {
  const app = await api();
  const { project, observation } = await seen(app, 'I-19', 'Attach');
  const raised = await createIssue(app, observation.id);
  const item = await createOpenItem(app, project.id);

  expect(
    (await post(app, `/v1/issues/${raised.id}/open-items/${item.id}`)).status,
  ).toBe(204);
  expect((await issue(app, project.id, 1)).openItems).toEqual([item]);

  const again = await post(
    app,
    `/v1/issues/${raised.id}/open-items/${item.id}`,
  );
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({
    message: 'that open item is already on this issue',
  });
});

test('an open item from another job cannot be attached to a finding', async () => {
  const app = await api();
  const mine = await seen(app, 'I-20', 'Mine');
  const theirs = await createProject(app, 'I-20b', 'Theirs');
  const raised = await createIssue(app, mine.observation.id);
  const item = await createOpenItem(app, theirs.id);

  const response = await post(
    app,
    `/v1/issues/${raised.id}/open-items/${item.id}`,
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    message: 'that open item is on another project',
  });
});

// ── A job's issues, with their state across every visit ────────────────────

test('a project lists its issues by identifier, open and closed alike', async () => {
  const app = await api();
  const { project, walk, observation } = await seen(app, 'I-21', 'The register');

  const first = await createIssue(app, observation.id, 'Safety / Code');
  const second = await createIssue(
    app,
    (await createObservation(app, walk.id, { observed: 'Second finding' })).id,
    'Accessibility',
  );
  await closeIssue(app, second.id, { note: 'Not in scope after all' });

  const listed = await issues(app, project.id);

  // A closed issue stays in the register: the lifecycle is the point, and a
  // list that hid the closed ones would be the write-up with no follow-up all
  // over again.
  expect(listed.map((row) => row.number)).toEqual([1, 2]);
  expect(listed.map((row) => row.category)).toEqual([
    'Safety / Code',
    'Accessibility',
  ]);
  expect(listed[0]?.closedAt).toBeNull();
  expect(listed[1]?.closedAt).not.toBeNull();
  expect(listed[0]?.id).toBe(first.id);
});

test('a project with no issues lists none, and a project that does not exist is a 404', async () => {
  const app = await api();
  const project = await createProject(app, 'I-22', 'Nothing found');

  expect(await issues(app, project.id)).toEqual([]);

  const response = await app.fetch(`/v1/projects/${NO_SUCH}/issues`);
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ message: 'no project with that id' });
});

test('the identifier sequence is bookkeeping and never reaches the wire', async () => {
  const app = await api();
  const { project, observation } = await seen(app, 'I-23', 'Not a count');
  await createIssue(app, observation.id);

  // A high-water mark, not a count of anything: a screen reading it as
  // "issues on this job" would be wrong the first time a promotion was
  // refused. What a project's issues are is the list, whose length is the
  // count — the shape exposure has.
  const keys = [
    'archivedAt',
    'createdAt',
    'currentPhaseId',
    'id',
    'name',
    'projectNumber',
  ];
  expect(Object.keys(project).sort()).toEqual(keys);

  const read = await app.fetch(`/v1/projects/${project.id}`);
  expect(Object.keys((await read.json()) as object).sort()).toEqual(keys);

  const listed = await app.fetch('/v1/projects');
  expect(
    Object.keys(((await listed.json()) as object[])[0] ?? {}).sort(),
  ).toEqual(keys);
});
