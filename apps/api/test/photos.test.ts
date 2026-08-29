import { afterEach, expect, test } from 'vitest';
import {
  A_PIXEL,
  addPhoto,
  createIssue,
  createObservation,
  createProject,
  createSiteVisit,
  photoBody,
  startFloor,
  startTestApi,
  type IssueResponse,
  type PhotoResponse,
  type SiteVisitDetail,
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

async function issue(app: TestApi, projectId: string, number: number) {
  const response = await app.fetch(`/v1/projects/${projectId}/issues/${number}`);
  expect(response.status).toBe(200);
  return (await response.json()) as IssueResponse;
}

async function withoutPhotos(app: TestApi, siteVisitId: string) {
  const path = `/v1/site-visits/${siteVisitId}/issues-without-photos`;
  const response = await app.fetch(path);
  expect(response.status).toBe(200);
  return (await response.json()) as IssueResponse[];
}

function completeFloor(app: TestApi, floorId: string, completedAt: string) {
  return post(app, `/v1/site-visit-floors/${floorId}/complete`, { completedAt });
}

/**
 * A walk with the schedule every binning test below reads: floor 3 walked
 * 13:00 to 13:45, floor 4 walked 14:00 to 14:30, and a quarter of an hour
 * between them that belongs to neither.
 */
async function walked(app: TestApi, projectNumber: string) {
  const project = await createProject(app, projectNumber, 'Photo binning');
  const walk = await createSiteVisit(app, project.id, {
    startedAt: '2026-07-23T12:30:00.000Z',
  });

  const third = await startFloor(app, walk.id, '3', '2026-07-23T13:00:00.000Z');
  expect(
    (await completeFloor(app, third.id, '2026-07-23T13:45:00.000Z')).status,
  ).toBe(200);

  const fourth = await startFloor(app, walk.id, '4', '2026-07-23T14:00:00.000Z');
  expect(
    (await completeFloor(app, fourth.id, '2026-07-23T14:30:00.000Z')).status,
  ).toBe(200);

  return { project, walk };
}

/** A finding on a walk, so a filename has something on the job to match. */
async function finding(app: TestApi, siteVisitId: string, floor = '3') {
  const observation = await createObservation(app, siteVisitId, { floor });
  return createIssue(app, observation.id);
}

// ── Adding a photograph to a walk ────────────────────────────────────────

test('a photograph is added to a walk and keeps the name it arrived with', async () => {
  const app = await api();
  const { walk } = await walked(app, 'P-1');

  const response = await post(app, `/v1/site-visits/${walk.id}/photos`, {
    ...photoBody({ filename: '3-west stair-issue-4.jpg' }),
  });
  expect(response.status).toBe(201);

  const photo = (await response.json()) as PhotoResponse;
  expect(photo.filename).toBe('3-west stair-issue-4.jpg');
  expect(photo.siteVisitId).toBe(walk.id);
  expect(photo.contentType).toBe('image/png');
  expect(photo.byteSize).toBe(Buffer.from(A_PIXEL, 'base64').byteLength);
  expect(photo.takenAt).toBe('2026-07-23T13:20:00.000Z');

  // The walk's photographs are read from the walk, in the order taken.
  expect((await visit(app, walk.id)).photos).toEqual([photo]);
});

test('a photograph carries the two bindings and never its bytes', async () => {
  const app = await api();
  const { walk } = await walked(app, 'P-2');
  const photo = await addPhoto(app, walk.id);

  // The bytes are in the object store; the row keeps the key and the key is
  // not the record's business either. A `bytes` field here would be the
  // acceptance criterion broken in the one place anybody would see it.
  expect(Object.keys(photo).sort()).toEqual([
    'byteSize',
    'contentType',
    'createdAt',
    'filename',
    'floor',
    'id',
    'issueNumber',
    'siteVisitId',
    'takenAt',
  ]);
});

test('the bytes come back as what they are', async () => {
  const app = await api();
  const { walk } = await walked(app, 'P-3');
  const photo = await addPhoto(app, walk.id);

  const response = await app.fetch(`/v1/photos/${photo.id}/bytes`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('image/png');

  const bytes = Buffer.from(await response.arrayBuffer());
  expect(bytes.toString('base64')).toBe(A_PIXEL);
});

test('the bytes of no photograph are a 404', async () => {
  const app = await api();
  const response = await app.fetch(`/v1/photos/${NO_SUCH}/bytes`);
  expect(response.status).toBe(404);
});

test('a photograph on no such walk is refused', async () => {
  const app = await api();
  const response = await post(app, `/v1/site-visits/${NO_SUCH}/photos`, photoBody());
  expect(response.status).toBe(404);
});

test('the same file added to the same walk twice is refused', async () => {
  const app = await api();
  const { walk } = await walked(app, 'P-4');
  await addPhoto(app, walk.id, { filename: 'DSC_1201.jpg' });

  const again = await post(app, `/v1/site-visits/${walk.id}/photos`, {
    ...photoBody({ filename: 'DSC_1201.jpg' }),
  });
  // A hundred photographs sent twice after a signal drop is one refusal each,
  // not a doubled walk.
  expect(again.status).toBe(409);

  expect((await visit(app, walk.id)).photos).toHaveLength(1);
});

test('the same filename on another walk is another photograph', async () => {
  const app = await api();
  const { project, walk } = await walked(app, 'P-5');
  const second = await createSiteVisit(app, project.id, {
    startedAt: '2026-08-14T13:00:00.000Z',
  });

  await addPhoto(app, walk.id, { filename: 'DSC_1201.jpg' });
  const later = await addPhoto(app, second.id, { filename: 'DSC_1201.jpg' });

  expect(later.filename).toBe('DSC_1201.jpg');
  expect((await visit(app, second.id)).photos).toHaveLength(1);
});

test.each([
  ['filename', { filename: '   ' }],
  ['bytes', { bytes: '' }],
  ['contentType', { contentType: 'text/html' }],
  ['takenAt', { takenAt: 'the afternoon' }],
])('a photograph with a bad %s is refused rather than stored', async (_field, patch) => {
  const app = await api();
  const { walk } = await walked(app, `P-6-${_field}`);

  const response = await post(app, `/v1/site-visits/${walk.id}/photos`, {
    ...photoBody(patch),
  });
  expect(response.status).toBe(400);
  expect((await visit(app, walk.id)).photos).toHaveLength(0);
});

test('a photograph with no time is refused rather than binned to now', async () => {
  const app = await api();
  const { walk } = await walked(app, 'P-7');
  const { takenAt: _dropped, ...withoutTime } = photoBody();

  const response = await post(app, `/v1/site-visits/${walk.id}/photos`, withoutTime);
  // The clock would bin it to whichever floor was being walked at the moment
  // of the request, which is exactly the guess the ticket asks not to make.
  expect(response.status).toBe(400);
});

// ── Binning to a floor by the timestamp (story 63) ───────────────────────

test.each([
  ['B-1', 'inside a window', '2026-07-23T13:20:00.000Z', '3'],
  ['B-2', 'at the instant the floor was started', '2026-07-23T13:00:00.000Z', '3'],
  ['B-3', 'at the instant the floor was completed', '2026-07-23T13:45:00.000Z', '3'],
  ['B-4', 'inside the second window', '2026-07-23T14:10:00.000Z', '4'],
  ['B-5', 'a second before every window', '2026-07-23T12:59:59.000Z', null],
  ['B-6', 'between the two windows', '2026-07-23T13:50:00.000Z', null],
  ['B-7', 'a second after the last window', '2026-07-23T14:30:01.000Z', null],
])(
  'a photograph taken %s bins to %s',
  async (projectNumber, name, takenAt, floor) => {
    const app = await api();
    const { walk } = await walked(app, projectNumber);

    const photo = await addPhoto(app, walk.id, { takenAt, filename: `${name}.jpg` });
    expect(photo.floor).toBe(floor);
  },
);

test('a floor still being walked has an open-ended window', async () => {
  const app = await api();
  const project = await createProject(app, 'B-8', 'Never completed');
  const walk = await createSiteVisit(app, project.id, {
    startedAt: '2026-07-23T12:30:00.000Z',
  });
  await startFloor(app, walk.id, 'PH', '2026-07-23T15:00:00.000Z');

  // The last floor of a walk is the one most often left open, and a
  // photograph taken on it is not ambiguous just because nobody said "done".
  const photo = await addPhoto(app, walk.id, { takenAt: '2026-07-23T15:40:00.000Z' });
  expect(photo.floor).toBe('PH');
});

test('a photograph inside two windows at once is left unbound', async () => {
  const app = await api();
  const project = await createProject(app, 'B-9', 'Doubled back');
  const walk = await createSiteVisit(app, project.id, {
    startedAt: '2026-07-23T12:30:00.000Z',
  });

  // Floor 3 is left open and floor 4 started anyway, which is a walk where
  // the engineer doubled back. 14:10 is genuinely on both.
  await startFloor(app, walk.id, '3', '2026-07-23T13:00:00.000Z');
  await startFloor(app, walk.id, '4', '2026-07-23T14:00:00.000Z');

  const inside = await addPhoto(app, walk.id, {
    takenAt: '2026-07-23T14:10:00.000Z',
    filename: 'both.jpg',
  });
  // Two windows contain it, so which floor it was taken on is not known.
  // Picking one would be the guess the ticket refuses.
  expect(inside.floor).toBeNull();

  const before = await addPhoto(app, walk.id, {
    takenAt: '2026-07-23T13:30:00.000Z',
    filename: 'one.jpg',
  });
  expect(before.floor).toBe('3');
});

test('a walk with no schedule bins nothing', async () => {
  const app = await api();
  const project = await createProject(app, 'B-10', 'No floors');
  const walk = await createSiteVisit(app, project.id);

  const photo = await addPhoto(app, walk.id);
  expect(photo.floor).toBeNull();
});

test('another walk’s schedule is no part of this one', async () => {
  const app = await api();
  const { project } = await walked(app, 'B-11');
  const second = await createSiteVisit(app, project.id, {
    startedAt: '2026-07-23T12:30:00.000Z',
  });

  // The same afternoon, on the same job, but a different walk.
  const photo = await addPhoto(app, second.id, {
    takenAt: '2026-07-23T13:20:00.000Z',
  });
  expect(photo.floor).toBeNull();
});

// ── Binding to a finding by the filename (story 64) ──────────────────────

test.each([
  ['F-1', 'issue-4.jpg'],
  ['F-2', '3-west stair-issue-4.jpg'],
  ['F-3', 'B1 MDP room ISS-4.jpeg'],
  ['F-4', 'iss_4 north elevation.png'],
  ['F-5', 'Issue 4.jpg'],
  ['F-6', 'issue4.jpg'],
  // Underscore-joined, which is the shape a phone and a messaging app
  // actually produce. A `\b` before the marker found no boundary after an
  // underscore and bound every one of these to nothing — while that same
  // character is an allowed separator on the other side of the marker.
  ['F-7', 'IMG_20260723_132045_issue4.jpg'],
  ['F-8', 'photo_issue_4.jpg'],
  ['F-9', '3_west_stair_iss_4.jpg'],
])('the filename %s binds to the issue it names', async (projectNumber, filename) => {
  const app = await api();
  const { walk } = await walked(app, projectNumber);

  // Four findings, so the number in the name is one of several on the job.
  for (let raised = 0; raised < 4; raised += 1) {
    await finding(app, walk.id);
  }

  const photo = await addPhoto(app, walk.id, { filename });
  expect(photo.issueNumber).toBe(4);
});

test('a camera’s own filename binds to nothing', async () => {
  const app = await api();
  const { walk } = await walked(app, 'F-10');
  for (let raised = 0; raised < 5; raised += 1) {
    await finding(app, walk.id);
  }

  // `IMG_0003` names issue 3 to a reader who takes any integer for an
  // identifier. It is a camera's counter and this is the case the ticket
  // names by hand.
  //
  // `3-west stair` matters more. ADR-0018 says these filenames encode the
  // floor as well as the finding, so a bare integer at the front of the name
  // is the floor — and every photograph on floor 3 of a job with three
  // findings would otherwise arrive bound to the wrong one.
  //
  // The last four are what a *letter* before the marker buys, which is what
  // the lookbehind guards and what makes the underscore cases above safe.
  for (const filename of [
    'IMG_0003.jpg',
    'IMG 0003.jpg',
    'PXL_20260723_132045.jpg',
    'DSC_0004.jpg',
    '3-west stair.jpg',
    '3 - west stair landing.jpg',
    'dismissed-3.jpg',
    'Missouri-3.jpg',
    'issuer-3.jpg',
    'reissue-3.jpg',
  ]) {
    const photo = await addPhoto(app, walk.id, { filename });
    expect(photo.issueNumber, filename).toBeNull();
  }
});

test('a filename naming an issue this job does not have binds to nothing', async () => {
  const app = await api();
  const { walk } = await walked(app, 'F-11');
  await finding(app, walk.id);

  const photo = await addPhoto(app, walk.id, { filename: 'issue-12.jpg' });
  expect(photo.issueNumber).toBeNull();
});

test('an identifier is the job’s, so another job’s number binds to nothing', async () => {
  const app = await api();
  const { walk } = await walked(app, 'F-12');

  const elsewhere = await createProject(app, 'F-13', 'Another job');
  const otherWalk = await createSiteVisit(app, elsewhere.id);
  await finding(app, otherWalk.id);

  // Issue 1 exists, on the other project. This walk's job has none.
  const photo = await addPhoto(app, walk.id, { filename: 'issue-1.jpg' });
  expect(photo.issueNumber).toBeNull();
});

test('a filename naming two different findings binds to neither', async () => {
  const app = await api();
  const { walk } = await walked(app, 'F-14');
  await finding(app, walk.id);
  await finding(app, walk.id);

  const both = await addPhoto(app, walk.id, { filename: 'issue-1 and issue-2.jpg' });
  expect(both.issueNumber).toBeNull();

  // The same one named twice is still one finding.
  const twice = await addPhoto(app, walk.id, { filename: 'issue-2-iss-2.jpg' });
  expect(twice.issueNumber).toBe(2);
});

test('binding by filename writes nothing to the finding', async () => {
  const app = await api();
  const { project, walk } = await walked(app, 'F-15');
  const raised = await finding(app, walk.id);

  await addPhoto(app, walk.id, { filename: 'issue-1.jpg' });

  const after = await issue(app, project.id, 1);
  // A filename is not a sighting. A sighting is an observation, and promoting
  // one is deliberate (ADR-0031).
  expect(after.observations).toEqual(raised.observations);
  expect(after.photos).toHaveLength(1);
});

// ── The two mechanisms are independent ───────────────────────────────────

test('a photograph may have either binding, both, or neither', async () => {
  const app = await api();
  const { walk } = await walked(app, 'I-1');
  await finding(app, walk.id);

  const both = await addPhoto(app, walk.id, {
    filename: 'issue-1.jpg',
    takenAt: '2026-07-23T13:20:00.000Z',
  });
  expect([both.floor, both.issueNumber]).toEqual(['3', 1]);

  const floorOnly = await addPhoto(app, walk.id, {
    filename: 'IMG_0100.jpg',
    takenAt: '2026-07-23T14:10:00.000Z',
  });
  expect([floorOnly.floor, floorOnly.issueNumber]).toEqual(['4', null]);

  const issueOnly = await addPhoto(app, walk.id, {
    filename: 'issue-1 again.jpg',
    takenAt: '2026-07-23T18:00:00.000Z',
  });
  expect([issueOnly.floor, issueOnly.issueNumber]).toEqual([null, 1]);

  const neither = await addPhoto(app, walk.id, {
    filename: 'IMG_0101.jpg',
    takenAt: '2026-07-23T18:00:00.000Z',
  });
  expect([neither.floor, neither.issueNumber]).toEqual([null, null]);
});

// ── Correcting a binding (story 65) ──────────────────────────────────────

test('a floor binding is corrected in one action', async () => {
  const app = await api();
  const { walk } = await walked(app, 'C-1');
  const photo = await addPhoto(app, walk.id, { takenAt: '2026-07-23T13:20:00.000Z' });
  expect(photo.floor).toBe('3');

  const response = await post(app, `/v1/photos/${photo.id}/floor`, { floor: '4' });
  expect(response.status).toBe(200);
  expect(((await response.json()) as PhotoResponse).floor).toBe('4');

  const [stored] = (await visit(app, walk.id)).photos;
  expect(stored?.floor).toBe('4');
  // The name is the mechanism, and a correction never rewrites it.
  expect(stored?.filename).toBe(photo.filename);
});

test('a floor nobody formally started can still be named', async () => {
  const app = await api();
  const { walk } = await walked(app, 'C-2');
  const photo = await addPhoto(app, walk.id);

  // The schedule is not a list of the floors that exist (ADR-0030).
  const response = await post(app, `/v1/photos/${photo.id}/floor`, { floor: 'M' });
  expect(response.status).toBe(200);
  expect(((await response.json()) as PhotoResponse).floor).toBe('M');
});

test('a floor binding is cleared with null', async () => {
  const app = await api();
  const { walk } = await walked(app, 'C-3');
  const photo = await addPhoto(app, walk.id, { takenAt: '2026-07-23T13:20:00.000Z' });

  const response = await post(app, `/v1/photos/${photo.id}/floor`, { floor: null });
  expect(response.status).toBe(200);
  expect(((await response.json()) as PhotoResponse).floor).toBeNull();
});

test('a blank floor is refused rather than stored', async () => {
  const app = await api();
  const { walk } = await walked(app, 'C-4');
  const photo = await addPhoto(app, walk.id, { takenAt: '2026-07-23T13:20:00.000Z' });

  const response = await post(app, `/v1/photos/${photo.id}/floor`, { floor: '  ' });
  expect(response.status).toBe(400);

  const [stored] = (await visit(app, walk.id)).photos;
  expect(stored?.floor).toBe('3');
});

test('an issue binding is corrected and cleared by the identifier', async () => {
  const app = await api();
  const { walk } = await walked(app, 'C-5');
  await finding(app, walk.id);
  await finding(app, walk.id);
  const photo = await addPhoto(app, walk.id, { filename: 'issue-1.jpg' });
  expect(photo.issueNumber).toBe(1);

  const corrected = await post(app, `/v1/photos/${photo.id}/issue`, { issueNumber: 2 });
  expect(corrected.status).toBe(200);
  expect(((await corrected.json()) as PhotoResponse).issueNumber).toBe(2);

  const cleared = await post(app, `/v1/photos/${photo.id}/issue`, { issueNumber: null });
  expect(cleared.status).toBe(200);
  expect(((await cleared.json()) as PhotoResponse).issueNumber).toBeNull();
});

test('a photograph cannot be bound to a finding on another job', async () => {
  const app = await api();
  const { walk } = await walked(app, 'C-6');
  const photo = await addPhoto(app, walk.id);

  const elsewhere = await createProject(app, 'C-7', 'Another job');
  const otherWalk = await createSiteVisit(app, elsewhere.id);
  await finding(app, otherWalk.id);

  // Issue 1 exists, and it is not this job's to evidence.
  const response = await post(app, `/v1/photos/${photo.id}/issue`, { issueNumber: 1 });
  expect(response.status).toBe(404);
});

test('correcting a photograph that does not exist is a 404', async () => {
  const app = await api();
  expect((await post(app, `/v1/photos/${NO_SUCH}/floor`, { floor: '3' })).status).toBe(404);
  expect((await post(app, `/v1/photos/${NO_SUCH}/issue`, { issueNumber: 1 })).status).toBe(404);
});

// ── Which findings still have no photo evidence (story 66) ───────────────

test('a finding seen on the walk with no photograph is on the list', async () => {
  const app = await api();
  const { walk } = await walked(app, 'E-1');
  const raised = await finding(app, walk.id);

  const listed = await withoutPhotos(app, walk.id);
  // A list and not a number, so the count and the screen it links to cannot
  // disagree (ADR-0027's shape).
  expect(listed.map((entry) => entry.number)).toEqual([raised.number]);
});

test('a photograph on the walk takes the finding off the list', async () => {
  const app = await api();
  const { walk } = await walked(app, 'E-2');
  await finding(app, walk.id);

  await addPhoto(app, walk.id, { filename: 'issue-1.jpg' });
  expect(await withoutPhotos(app, walk.id)).toEqual([]);
});

test('the evidence has to be from this walk', async () => {
  const app = await api();
  const { project, walk } = await walked(app, 'E-3');
  const raised = await finding(app, walk.id);
  await addPhoto(app, walk.id, { filename: 'issue-1.jpg' });

  // A second walk, on which the same finding is seen again with no photograph.
  const second = await createSiteVisit(app, project.id, {
    startedAt: '2026-08-14T13:00:00.000Z',
  });
  const again = await createObservation(app, second.id, { floor: '3' });
  expect(
    (await post(app, `/v1/issues/${raised.id}/observations/${again.id}`)).status,
  ).toBe(204);

  // July's photograph does not evidence August's re-observation, and the
  // report about to be written is August's.
  expect((await withoutPhotos(app, second.id)).map((e) => e.number)).toEqual([1]);
  expect(await withoutPhotos(app, walk.id)).toEqual([]);
});

test('a finding never seen on this walk is no part of its list', async () => {
  const app = await api();
  const { project, walk } = await walked(app, 'E-4');
  await finding(app, walk.id);

  const second = await createSiteVisit(app, project.id, {
    startedAt: '2026-08-14T13:00:00.000Z',
  });
  expect(await withoutPhotos(app, second.id)).toEqual([]);
});

test('a photograph bound by name to a finding not seen on the walk adds nothing', async () => {
  const app = await api();
  const { project, walk } = await walked(app, 'E-5');
  await finding(app, walk.id);

  const second = await createSiteVisit(app, project.id, {
    startedAt: '2026-08-14T13:00:00.000Z',
  });
  const photo = await addPhoto(app, second.id, { filename: 'issue-1.jpg' });
  expect(photo.issueNumber).toBe(1);

  // A filename is not a sighting, so the finding is not on this walk and the
  // list is about the walk.
  expect(await withoutPhotos(app, second.id)).toEqual([]);
});

test('the list of a walk that does not exist is a 404', async () => {
  const app = await api();
  const response = await app.fetch(`/v1/site-visits/${NO_SUCH}/issues-without-photos`);
  expect(response.status).toBe(404);
});

// ── Nothing edits a photograph beyond its bindings ───────────────────────

test.each(['PATCH', 'PUT', 'DELETE'])(
  'nothing rewrites a photograph: %s is refused',
  async (method) => {
    const app = await api();
    const { walk } = await walked(app, `X-${method}`);
    const photo = await addPhoto(app, walk.id);

    // A DELETE carries no body, and so no content-type either.
    const carries = method !== 'DELETE';
    const response = await app.fetch(`/v1/photos/${photo.id}`, {
      method,
      ...(carries ? { headers: json, body: JSON.stringify({ filename: 'x.jpg' }) } : {}),
    });
    expect(response.status, method).toBe(404);

    expect((await visit(app, walk.id)).photos).toEqual([photo]);
  },
);
