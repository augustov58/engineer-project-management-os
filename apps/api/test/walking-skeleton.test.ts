import { afterEach, expect, test } from 'vitest';
import {
  createSkeletonRecord,
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

test('a record written through the API is read back out of PostgreSQL', async () => {
  const app = await api();

  const created = await createSkeletonRecord(app, 'walking skeleton');

  const response = await app.fetch('/skeleton-records');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([
    { id: created.id, label: 'walking skeleton', createdAt: created.createdAt },
  ]);
});

test('health reaches PostgreSQL and the BullMQ queue, and no jobs are queued', async () => {
  const app = await api();

  const response = await app.fetch('/health');

  // 200 is the reachability assertion: the route queries PostgreSQL and asks
  // BullMQ for job counts, and either failing would surface here as a 500.
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ queue: { waiting: 0, active: 0 } });
});

test('records are stamped from the injected time source, not the database', async () => {
  const time = fakeTimeSource(new Date('2026-03-01T12:00:00.000Z'));
  const app = await api({ timeSource: time });

  const first = await createSkeletonRecord(app, 'issued');
  time.advance(90 * 24 * 60 * 60 * 1000);
  const second = await createSkeletonRecord(app, 'still open');

  expect(first.createdAt).toBe('2026-03-01T12:00:00.000Z');
  expect(second.createdAt).toBe('2026-05-30T12:00:00.000Z');
});

test('the time source defaults to the real clock', async () => {
  const app = await api();
  const before = Date.now();

  const created = await createSkeletonRecord(app, 'now');

  const stamped = Date.parse(created.createdAt);
  expect(stamped).toBeGreaterThanOrEqual(before);
  expect(stamped).toBeLessThanOrEqual(Date.now());
});

test('a record without a label is rejected and nothing is stored', async () => {
  const app = await api();

  const response = await app.fetch('/skeleton-records', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });

  expect(response.status).toBe(400);
  expect(await (await app.fetch('/skeleton-records')).json()).toEqual([]);
});
