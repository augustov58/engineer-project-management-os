import { afterEach, expect, test } from 'vitest';
import {
  createObservation,
  createProject,
  createSiteVisit,
  fakeTimeSource,
  observationBody,
  startFloor,
  startTestApi,
  type ObservationResponse,
  type SiteVisitDetail,
  type SiteVisitFloorResponse,
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

async function visit(app: TestApi, id: string) {
  const response = await app.fetch(`/v1/site-visits/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as SiteVisitDetail;
}

async function visits(app: TestApi, projectId: string) {
  const response = await app.fetch(`/v1/projects/${projectId}/site-visits`);
  expect(response.status).toBe(200);
  return (await response.json()) as SiteVisitResponse[];
}

function endVisit(app: TestApi, id: string, endedAt?: string) {
  return post(app, `/v1/site-visits/${id}/end`, endedAt === undefined ? {} : { endedAt });
}

function completeFloor(app: TestApi, floorId: string, completedAt?: string) {
  return post(
    app,
    `/v1/site-visit-floors/${floorId}/complete`,
    completedAt === undefined ? {} : { completedAt },
  );
}

/** A project, which is all a site visit needs to exist. */
function job(app: TestApi, number: string, name: string) {
  return createProject(app, number, name);
}

// ── One dated observation event against a building (story 49) ──────────────

test('a site visit is created against a project with a start and an end', async () => {
  const app = await api();
  const project = await job(app, 'V-1', 'Riverside clinic');

  const response = await post(app, `/v1/projects/${project.id}/site-visits`, {
    startedAt: '2026-07-23T13:00:00.000Z',
    endedAt: '2026-07-23T16:30:00.000Z',
  });

  expect(response.status).toBe(201);
  const created = (await response.json()) as SiteVisitResponse;
  expect(created.projectId).toBe(project.id);
  expect(created.startedAt).toBe('2026-07-23T13:00:00.000Z');
  expect(created.endedAt).toBe('2026-07-23T16:30:00.000Z');
});

test('the visit’s date is the day it started, derived and stored nowhere', async () => {
  const app = await api();
  const project = await job(app, 'V-2', 'Dated');

  const created = await createSiteVisit(app, project.id, {
    startedAt: '2026-07-23T13:00:00.000Z',
    endedAt: '2026-07-23T16:30:00.000Z',
  });

  // "One *dated* observation event" — and the date cannot disagree with the
  // start time, because there is no second column holding it.
  expect(created.visitedOn).toBe('2026-07-23');
  expect(await visits(app, project.id)).toEqual([created]);
});

test('the start is the engineer’s, or the injected time source', async () => {
  const time = fakeTimeSource(new Date('2026-03-02T09:00:00.000Z'));
  const app = await api({ timeSource: time });
  const project = await job(app, 'V-3', 'Backdated');

  // The visits worth entering first happened long before this row existed.
  const backdated = await createSiteVisit(app, project.id, {
    startedAt: '2025-11-14T14:00:00.000Z',
  });
  expect(backdated.startedAt).toBe('2025-11-14T14:00:00.000Z');
  expect(backdated.visitedOn).toBe('2025-11-14');

  const today = await createSiteVisit(app, project.id);
  expect(today.startedAt).toBe('2026-03-02T09:00:00.000Z');
});

test('a visit against a project that does not exist is a 404', async () => {
  const app = await api();
  const response = await post(app, `/v1/projects/${NO_SUCH}/site-visits`, {});

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ message: 'no project with that id' });
});

test('site visits list oldest first', async () => {
  const app = await api();
  const project = await job(app, 'V-4', 'Two walks');

  const later = await createSiteVisit(app, project.id, {
    startedAt: '2026-07-23T13:00:00.000Z',
  });
  const earlier = await createSiteVisit(app, project.id, {
    startedAt: '2026-05-02T09:00:00.000Z',
  });

  expect((await visits(app, project.id)).map((row) => row.id)).toEqual([
    earlier.id,
    later.id,
  ]);
});

test('reading a visit that does not exist is a 404', async () => {
  const app = await api();
  const response = await app.fetch(`/v1/site-visits/${NO_SUCH}`);

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    message: 'no site visit with that id',
  });
});

// ── A walk in progress, ended when it is over ──────────────────────────────

test('a visit may be created still under way and ended afterwards', async () => {
  const time = fakeTimeSource(new Date('2026-07-23T13:00:00.000Z'));
  const app = await api({ timeSource: time });
  const project = await job(app, 'W-1', 'Still walking');

  const created = await createSiteVisit(app, project.id);
  // The per-floor schedule is recorded *during* the visit (story 50), so a
  // walk has to be able to exist before it is over.
  expect(created.endedAt).toBeNull();

  time.advance(3 * 60 * 60 * 1000);
  const response = await endVisit(app, created.id);
  expect(response.status).toBe(200);
  expect(((await response.json()) as SiteVisitResponse).endedAt).toBe(
    '2026-07-23T16:00:00.000Z',
  );

  expect((await visit(app, created.id)).endedAt).toBe(
    '2026-07-23T16:00:00.000Z',
  );
});

test('ending a visit twice is refused rather than restamped', async () => {
  const app = await api();
  const project = await job(app, 'W-2', 'Ended once');
  const created = await createSiteVisit(app, project.id, {
    startedAt: '2026-07-23T13:00:00.000Z',
  });

  expect((await endVisit(app, created.id, '2026-07-23T16:00:00.000Z')).status).toBe(200);

  const again = await endVisit(app, created.id, '2026-07-23T18:00:00.000Z');
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({
    message: 'that site visit has already ended',
  });

  // Refused, and the first stamp still stands.
  expect((await visit(app, created.id)).endedAt).toBe('2026-07-23T16:00:00.000Z');
});

test('a visit cannot end before it started', async () => {
  const app = await api();
  const project = await job(app, 'W-3', 'Backwards');
  const created = await createSiteVisit(app, project.id, {
    startedAt: '2026-07-23T13:00:00.000Z',
  });

  const response = await endVisit(app, created.id, '2026-07-23T11:00:00.000Z');
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    message: 'a site visit cannot end before it started',
  });
  expect((await visit(app, created.id)).endedAt).toBeNull();
});

test('creating a visit that ends before it starts is refused', async () => {
  const app = await api();
  const project = await job(app, 'W-4', 'Backwards at creation');

  const response = await post(app, `/v1/projects/${project.id}/site-visits`, {
    startedAt: '2026-07-23T13:00:00.000Z',
    endedAt: '2026-07-23T11:00:00.000Z',
  });

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    message: 'a site visit cannot end before it started',
  });
  expect(await visits(app, project.id)).toHaveLength(0);
});

test('ending a visit that does not exist is a 404', async () => {
  const app = await api();
  const response = await endVisit(app, NO_SUCH);

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    message: 'no site visit with that id',
  });
});

// ── The per-floor schedule (story 50) ──────────────────────────────────────

test('a floor records a start and a completion timestamp', async () => {
  const time = fakeTimeSource(new Date('2026-07-23T13:00:00.000Z'));
  const app = await api({ timeSource: time });
  const project = await job(app, 'F-1', 'Per-floor');
  const walk = await createSiteVisit(app, project.id);

  const floor = await startFloor(app, walk.id, '3');
  expect(floor.floor).toBe('3');
  expect(floor.startedAt).toBe('2026-07-23T13:00:00.000Z');
  // Still being walked.
  expect(floor.completedAt).toBeNull();

  time.advance(45 * 60 * 1000);
  const response = await completeFloor(app, floor.id);
  expect(response.status).toBe(200);

  const completed = (await response.json()) as SiteVisitFloorResponse;
  expect(completed.completedAt).toBe('2026-07-23T13:45:00.000Z');

  // The window a photograph's timestamp will be binned against (issue #11).
  const [stored] = (await visit(app, walk.id)).floors;
  expect(stored?.startedAt).toBe('2026-07-23T13:00:00.000Z');
  expect(stored?.completedAt).toBe('2026-07-23T13:45:00.000Z');
});

test.each([['B1'], ['M'], ['PH'], ['3']])(
  'floor %s is a designation the schedule accepts',
  async (designation) => {
    const app = await api();
    const project = await job(app, `F-${designation}`, 'Real buildings');
    const walk = await createSiteVisit(app, project.id);

    // The grammar writes `Floor N`, but a building with a basement, a
    // mezzanine or a penthouse has floors that are not numbers (ADR-0030).
    const floor = await startFloor(app, walk.id, designation);
    expect(floor.floor).toBe(designation);
  },
);

test('starting the same floor twice on one visit is refused', async () => {
  const app = await api();
  const project = await job(app, 'F-2', 'Once per walk');
  const walk = await createSiteVisit(app, project.id);

  await startFloor(app, walk.id, '3');

  const again = await post(app, `/v1/site-visits/${walk.id}/floors`, {
    floor: '3',
  });
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({
    message: 'that floor is already on this site visit’s schedule',
  });

  expect((await visit(app, walk.id)).floors).toHaveLength(1);
});

test('the same floor is startable on a different visit', async () => {
  const app = await api();
  const project = await job(app, 'F-3', 'Two walks, one floor');
  const first = await createSiteVisit(app, project.id, {
    startedAt: '2026-05-02T09:00:00.000Z',
  });
  const second = await createSiteVisit(app, project.id, {
    startedAt: '2026-07-23T13:00:00.000Z',
  });

  await startFloor(app, first.id, '3');
  await startFloor(app, second.id, '3');

  expect((await visit(app, first.id)).floors).toHaveLength(1);
  expect((await visit(app, second.id)).floors).toHaveLength(1);
});

test('completing a floor twice is refused rather than restamped', async () => {
  const app = await api();
  const project = await job(app, 'F-4', 'Completed once');
  const walk = await createSiteVisit(app, project.id, {
    startedAt: '2026-07-23T13:00:00.000Z',
  });
  const floor = await startFloor(app, walk.id, '3', '2026-07-23T13:00:00.000Z');

  expect((await completeFloor(app, floor.id, '2026-07-23T13:45:00.000Z')).status).toBe(200);

  const again = await completeFloor(app, floor.id, '2026-07-23T14:30:00.000Z');
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({
    message: 'that floor is already completed',
  });

  expect((await visit(app, walk.id)).floors[0]?.completedAt).toBe(
    '2026-07-23T13:45:00.000Z',
  );
});

test('a floor cannot be completed before it was started', async () => {
  const app = await api();
  const project = await job(app, 'F-5', 'Backwards floor');
  const walk = await createSiteVisit(app, project.id, {
    startedAt: '2026-07-23T13:00:00.000Z',
  });
  const floor = await startFloor(app, walk.id, '3', '2026-07-23T13:00:00.000Z');

  // A window that closed before it opened would bin every photograph on the
  // walk to nothing at all (issue #11).
  const response = await completeFloor(app, floor.id, '2026-07-23T12:00:00.000Z');
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    message: 'a floor cannot be completed before it was started',
  });
  expect((await visit(app, walk.id)).floors[0]?.completedAt).toBeNull();
});

test('the schedule lists floors in the order they were started', async () => {
  const app = await api();
  const project = await job(app, 'F-6', 'In order');
  const walk = await createSiteVisit(app, project.id);

  await startFloor(app, walk.id, 'PH', '2026-07-23T15:00:00.000Z');
  await startFloor(app, walk.id, 'B1', '2026-07-23T13:00:00.000Z');
  await startFloor(app, walk.id, '3', '2026-07-23T14:00:00.000Z');

  expect((await visit(app, walk.id)).floors.map((row) => row.floor)).toEqual([
    'B1',
    '3',
    'PH',
  ]);
});

test('starting a floor on a visit that does not exist is a 404', async () => {
  const app = await api();
  const response = await post(app, `/v1/site-visits/${NO_SUCH}/floors`, {
    floor: '3',
  });

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    message: 'no site visit with that id',
  });
});

test('completing a floor that does not exist is a 404', async () => {
  const app = await api();
  const response = await completeFloor(app, NO_SUCH);

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ message: 'no floor with that id' });
});

test('a blank floor designation is refused rather than stored', async () => {
  const app = await api();
  const project = await job(app, 'F-7', 'Blank floor');
  const walk = await createSiteVisit(app, project.id);

  const response = await post(app, `/v1/site-visits/${walk.id}/floors`, {
    floor: '   ',
  });
  expect(response.status).toBe(400);
  expect((await visit(app, walk.id)).floors).toHaveLength(0);
});

// ── An observation: a note, a time and a location (story 53) ───────────────

test('an observation is recorded with a note, a time and a location', async () => {
  const app = await api();
  const project = await job(app, 'O-1', 'One observation');
  const walk = await createSiteVisit(app, project.id);

  const response = await post(app, `/v1/site-visits/${walk.id}/observations`, {
    note: 'Fire-rated wall penetration left unsealed above the ceiling',
    observedAt: '2026-07-23T13:20:00.000Z',
    floor: '3',
    qualifier: 'Stair B',
    side: 'A',
  });

  expect(response.status).toBe(201);
  const created = (await response.json()) as ObservationResponse;
  expect(created.siteVisitId).toBe(walk.id);
  expect(created.note).toBe(
    'Fire-rated wall penetration left unsealed above the ceiling',
  );
  expect(created.observedAt).toBe('2026-07-23T13:20:00.000Z');
  // Stored as components, never as the composed string.
  expect(created.floor).toBe('3');
  expect(created.qualifier).toBe('Stair B');
  expect(created.side).toBe('A');
  expect(created.sector).toBeNull();
});

test('the observed time is the engineer’s, or the injected time source', async () => {
  const time = fakeTimeSource(new Date('2026-07-23T13:20:00.000Z'));
  const app = await api({ timeSource: time });
  const project = await job(app, 'O-2', 'Observed when');
  const walk = await createSiteVisit(app, project.id);

  const now = await createObservation(app, walk.id);
  expect(now.observedAt).toBe('2026-07-23T13:20:00.000Z');

  const supplied = await createObservation(app, walk.id, {
    observedAt: '2026-07-23T14:05:00.000Z',
  });
  expect(supplied.observedAt).toBe('2026-07-23T14:05:00.000Z');
});

// ── The location renders to the grammar string ─────────────────────────────

test('a location on a Side renders to the grammar string', async () => {
  const app = await api();
  const project = await job(app, 'L-1', 'Side');
  const walk = await createSiteVisit(app, project.id);

  const observation = await createObservation(app, walk.id, {
    floor: '3',
    qualifier: 'Stair B',
    side: 'A',
  });

  expect(observation.location).toBe('Floor 3 — Stair B, Side A');
});

test('a location in a Sector renders to the grammar string', async () => {
  const app = await api();
  const project = await job(app, 'L-2', 'Sector');
  const walk = await createSiteVisit(app, project.id);

  const observation = await createObservation(app, walk.id, {
    floor: '2',
    qualifier: 'Elevator lobby',
    side: undefined,
    sector: '4',
  });

  expect(observation.location).toBe('Floor 2 — Elevator lobby, Sector 4');
  expect(observation.side).toBeNull();
  expect(observation.sector).toBe('4');
});

test.each([
  ['B1', 'Sump pit', 'Floor B1 — Sump pit, Side A'],
  ['M', 'Mezzanine catwalk', 'Floor M — Mezzanine catwalk, Side A'],
  ['PH', 'Cooling tower', 'Floor PH — Cooling tower, Side A'],
])(
  'floor %s renders as Floor %s in the grammar string',
  async (floor, qualifier, expected) => {
    const app = await api();
    const project = await job(app, `L-${floor}`, 'Not a number');
    const walk = await createSiteVisit(app, project.id);

    const observation = await createObservation(app, walk.id, {
      floor,
      qualifier,
    });
    expect(observation.location).toBe(expected);
  },
);

test('the rendered string is derived on read and stored nowhere', async () => {
  const app = await api();
  const project = await job(app, 'L-3', 'Derived');
  const walk = await createSiteVisit(app, project.id);

  const created = await createObservation(app, walk.id);
  const [read] = (await visit(app, walk.id)).observations;

  // The same string from the create and from a later read, because both
  // compose it from the components rather than reading a column.
  expect(read?.location).toBe(created.location);
  expect(read?.location).toBe('Floor 3 — Stair B, Side A');
});

// ── Side and Sector never combine in one string (story 55) ─────────────────

test('an observation with both a side and a sector is refused', async () => {
  const app = await api();
  const project = await job(app, 'X-1', 'Both axes');
  const walk = await createSiteVisit(app, project.id);

  const response = await post(
    app,
    `/v1/site-visits/${walk.id}/observations`,
    observationBody({ side: 'A', sector: '4' }),
  );

  expect(response.status).toBe(400);
  // Refused rather than stored with one axis quietly dropped, which is the
  // corruption story 55 is about.
  expect((await visit(app, walk.id)).observations).toHaveLength(0);
});

test('an observation with neither a side nor a sector is refused', async () => {
  const app = await api();
  const project = await job(app, 'X-2', 'Neither axis');
  const walk = await createSiteVisit(app, project.id);

  const response = await post(
    app,
    `/v1/site-visits/${walk.id}/observations`,
    observationBody({ side: undefined, sector: undefined }),
  );

  // The grammar has no optional segment, so an empty axis is not a location.
  expect(response.status).toBe(400);
  expect((await visit(app, walk.id)).observations).toHaveLength(0);
});

test.each([
  ['side', { side: null, sector: '4' }],
  ['sector', { side: 'A', sector: null }],
])('an explicit null %s is refused too', async (_axis, body) => {
  const app = await api();
  const project = await job(app, `X-${_axis}`, 'Null axis');
  const walk = await createSiteVisit(app, project.id);

  // A null is what an interface sends when a field was left empty; it must
  // not be a way of saying the other axis is the only one.
  const response = await post(app, `/v1/site-visits/${walk.id}/observations`, {
    ...observationBody({ side: undefined, sector: undefined }),
    ...body,
  });

  expect(response.status).toBe(400);
  expect((await visit(app, walk.id)).observations).toHaveLength(0);
});

// ── The qualifier takes all five kinds of reference (story 54) ─────────────

test.each([
  ['landmark', 'Loading dock'],
  ['room-number-with-a-type-gloss', 'Room 304 (electrical closet)'],
  ['circulation-element', 'Stair B'],
  ['program-space', 'Operating room suite'],
  ['equipment-tag', 'AHU-2'],
])('the qualifier accepts a %s', async (kind, qualifier) => {
  const app = await api();
  const project = await job(app, `Q-${kind}`, 'Qualifiers');
  const walk = await createSiteVisit(app, project.id);

  const observation = await createObservation(app, walk.id, { qualifier });

  // Free text on purpose: a column that held only one of these would force
  // the field to match the tool.
  expect(observation.qualifier).toBe(qualifier);
  expect(observation.location).toBe(`Floor 3 — ${qualifier}, Side A`);
});

// ── Observations stay observations (story 56) ──────────────────────────────

test('observations are listable per visit and carry nothing that makes one a finding', async () => {
  const app = await api();
  const project = await job(app, 'N-1', 'Non-issues');
  const walk = await createSiteVisit(app, project.id);

  await createObservation(app, walk.id, { note: 'Ceiling tile displaced' });
  await createObservation(app, walk.id, {
    note: 'Panel schedule matches the drawings',
    qualifier: 'Room 304 (electrical closet)',
  });

  const listed = (await visit(app, walk.id)).observations;
  expect(listed).toHaveLength(2);

  // The majority case is an observation that never becomes anything. There is
  // no status, no category and no promotion on this record: becoming an issue
  // is ticket #10, and it arrives as a row pointing here, not a column.
  expect(Object.keys(listed[0] ?? {}).sort()).toEqual([
    'createdAt',
    'floor',
    'id',
    'location',
    'note',
    'observedAt',
    'qualifier',
    'sector',
    'side',
    'siteVisitId',
  ]);
});

test('observations list oldest observed first', async () => {
  const app = await api();
  const project = await job(app, 'N-2', 'In order');
  const walk = await createSiteVisit(app, project.id);

  const later = await createObservation(app, walk.id, {
    observedAt: '2026-07-23T15:00:00.000Z',
  });
  const earlier = await createObservation(app, walk.id, {
    observedAt: '2026-07-23T13:10:00.000Z',
  });

  expect(
    (await visit(app, walk.id)).observations.map((row) => row.id),
  ).toEqual([earlier.id, later.id]);
});

test('an observation belongs to one visit and reads only from it', async () => {
  const app = await api();
  const project = await job(app, 'N-3', 'Bound to a walk');
  const mine = await createSiteVisit(app, project.id, {
    startedAt: '2026-05-02T09:00:00.000Z',
  });
  const other = await createSiteVisit(app, project.id, {
    startedAt: '2026-07-23T13:00:00.000Z',
  });

  await createObservation(app, mine.id);

  expect((await visit(app, mine.id)).observations).toHaveLength(1);
  expect((await visit(app, other.id)).observations).toHaveLength(0);
});

test('a visit read on its own names the job it was against', async () => {
  const app = await api();
  const project = await job(app, 'N-4', 'Riverside clinic');
  const walk = await createSiteVisit(app, project.id);

  expect((await visit(app, walk.id)).project).toEqual({
    id: project.id,
    projectNumber: 'N-4',
    name: 'Riverside clinic',
  });
});

test('an observation against a visit that does not exist is a 404', async () => {
  const app = await api();
  const response = await post(
    app,
    `/v1/site-visits/${NO_SUCH}/observations`,
    observationBody(),
  );

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    message: 'no site visit with that id',
  });
});

test.each([
  ['note', '   '],
  ['floor', '\n\t '],
  ['qualifier', ' '],
  ['side', ' '],
])('a blank %s is refused rather than stored', async (field, blank) => {
  const app = await api();
  const project = await job(app, `Z-${field}`, 'Blank fields');
  const walk = await createSiteVisit(app, project.id);

  const response = await post(
    app,
    `/v1/site-visits/${walk.id}/observations`,
    observationBody({ [field]: blank }),
  );

  expect(response.status).toBe(400);
  expect((await visit(app, walk.id)).observations).toHaveLength(0);
});
