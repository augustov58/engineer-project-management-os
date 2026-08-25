import { afterEach, expect, test } from 'vitest';
import { startTestApi, type TestApi } from './harness.js';

const started: TestApi[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((instance) => instance.close()));
});

test('health reaches PostgreSQL and the BullMQ queue, and no jobs are queued', async () => {
  const app = await startTestApi();
  started.push(app);

  const response = await app.fetch('/v1/health');

  // 200 is the reachability assertion: the route queries PostgreSQL and asks
  // BullMQ for job counts, and either failing would surface here as a 500.
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    queue: { waiting: 0, active: 0 },
  });
});
