/**
 * The activity feed (story 107, ADR-0048).
 *
 * The feed and the audit read are two answers drawn from one record, so what is
 * asserted here is mostly about how they relate: that the one is the exact
 * reverse of the other, that the feed is bounded and cannot be widened into the
 * compliance record, and that the rows themselves are the same rows.
 */

import { afterEach, expect, test } from 'vitest';
import {
  createObservation,
  createOpenItem,
  createProject,
  createSiteVisit,
  fakeTimeSource,
  startTestApi,
  type AuditEntryResponse,
  type TestApi,
} from './harness.js';

const started: TestApi[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((instance) => instance.close()));
});

/**
 * A clock advanced by hand between the writes below.
 *
 * Two lines written in the same millisecond are ordered by a random v4 uuid —
 * a coin toss ADR-0048 records as accepted, because nothing derives a value
 * from this record's order. Every assertion here about *which* line comes first
 * therefore gives each one a millisecond of its own, so what is being tested is
 * the ordering and never the tie-break.
 */
async function api() {
  const clock = fakeTimeSource(new Date('2026-09-05T09:00:00.000Z'));
  const app = await startTestApi({ worker: false, timeSource: clock });
  started.push(app);
  return { app, clock };
}

/** "What happened on this project lately" — newest first, bounded. */
async function feed(app: TestApi, projectId: string, query = '') {
  const response = await app.fetch(`/v1/projects/${projectId}/activity${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as AuditEntryResponse[];
}

/** "What is the compliance history" — every line, oldest first. */
async function history(app: TestApi, projectId: string) {
  const response = await app.fetch(`/v1/projects/${projectId}/memory/audit`);
  expect(response.status).toBe(200);
  return (await response.json()) as AuditEntryResponse[];
}

/** A job with a spread of ordinary work behind it, a minute between each. */
async function busyProject(
  app: TestApi,
  clock: { advance: (milliseconds: number) => void },
) {
  const project = await createProject(app, 'F-1', 'Riser replacement');
  clock.advance(60_000);
  const walk = await createSiteVisit(app, project.id);
  for (const unresolved of ['Ceiling height', 'Panel schedule', 'Riser route']) {
    clock.advance(60_000);
    await createOpenItem(app, project.id, { unresolved });
  }
  clock.advance(60_000);
  await createObservation(app, walk.id);
  return project;
}

test('the feed is the audit read backwards, exactly', async () => {
  const { app, clock } = await api();
  const project = await busyProject(app, clock);

  const lately = await feed(app, project.id);
  const compliance = await history(app, project.id);

  // One total order — `created_at` then `id` — read in both directions, so the
  // two answers can never disagree about *what* happened while differing about
  // how it is read. That is the guarantee a second stream could not offer.
  expect(lately).toEqual([...compliance].reverse());
  expect(lately.length).toBe(6);
});

test('lately means newest first, and the job being recorded is last', async () => {
  const { app, clock } = await api();
  const project = await busyProject(app, clock);

  const lately = await feed(app, project.id);

  expect(lately.map((line) => line.action)).toEqual([
    'observation recorded',
    'open item raised',
    'open item raised',
    'open item raised',
    'site visit recorded',
    'project recorded',
  ]);
});

test('a job that exists has a feed, because being recorded is something that happened', async () => {
  const { app } = await api();
  const project = await createProject(app, 'F-1', 'Riser replacement');

  // "Nothing has happened here" is not a state this route can be in for a
  // project that exists: story 106 makes recording the job its own first line.
  expect((await feed(app, project.id)).map((line) => line.action)).toEqual([
    'project recorded',
  ]);
});

test('the feed is bounded, and the bound takes the newest and not the oldest', async () => {
  const { app, clock } = await api();
  const project = await createProject(app, 'F-1', 'Riser replacement');
  for (const unresolved of ['One', 'Two', 'Three', 'Four']) {
    clock.advance(60_000);
    await createOpenItem(app, project.id, { unresolved });
  }

  const two = await feed(app, project.id, '?limit=2');

  expect(two).toHaveLength(2);
  // The end of the record, never the beginning of it: `project recorded` is the
  // oldest line on this job and must not be in a page of the two most recent.
  expect(two.map((line) => line.detail)).toEqual(['Four', 'Three']);
});

test('the feed cannot be widened into the compliance record', async () => {
  const { app } = await api();
  const project = await createProject(app, 'F-1', 'Riser replacement');

  // The maximum is what keeps story 107's two questions two questions. Without
  // it this route is the audit read with a query parameter on it (ADR-0048).
  const tooMuch = await app.fetch(`/v1/projects/${project.id}/activity?limit=201`);
  expect(tooMuch.status).toBe(400);

  const none = await app.fetch(`/v1/projects/${project.id}/activity?limit=0`);
  expect(none.status).toBe(400);

  // And nothing else may be asked of it, so a filter cannot arrive by accident.
  const invented = await app.fetch(`/v1/projects/${project.id}/activity?action=x`);
  expect(invented.status).toBe(400);
});

test('a feed line is an audit line, with nothing added and nothing dropped', async () => {
  const { app } = await api();
  const project = await createProject(app, 'F-1', 'Riser replacement');
  await createOpenItem(app, project.id);

  for (const line of await feed(app, project.id)) {
    expect(Object.keys(line).sort()).toEqual([
      'action',
      'createdAt',
      'detail',
      'id',
      'projectId',
    ]);
    expect(line.projectId).toBe(project.id);
  }
});

test('one job never sees another job on its feed', async () => {
  const { app } = await api();
  const mine = await createProject(app, 'F-1', 'Riser replacement');
  const theirs = await createProject(app, 'F-2', 'Lab fit-out');
  await createOpenItem(app, theirs.id, { unresolved: 'Not mine' });

  expect((await feed(app, mine.id)).map((line) => line.detail)).toEqual([
    'F-1 — Riser replacement',
  ]);
});

test('the feed of an unknown project is a 404 and not an empty list', async () => {
  const { app } = await api();

  const response = await app.fetch(
    '/v1/projects/00000000-0000-4000-8000-000000000000/activity',
  );

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ message: 'no project with that id' });
});
