import { afterEach, expect, test } from 'vitest';
import { startTestApi, type TestApi } from './harness.js';

const started: TestApi[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((instance) => instance.close()));
});

/**
 * ADR-0012: v1 is a single-user personal tool — no login, no roles, no
 * tenancy. This reads the migrated schema rather than a response, because no
 * route can expose the absence of a table. It is the only test allowed past
 * the HTTP boundary, and `tableNames()` is all it may use.
 */
test('no users, roles, permissions or tenants table is introduced', async () => {
  const app = await startTestApi();
  started.push(app);

  const tables = await app.tableNames();

  // Guard the guard: a query that returned nothing would pass silently.
  expect(tables).toContain('projects');
  expect(tables).toContain('open_items');
  expect(tables).toContain('project_phases');
  expect(tables).toContain('submissions');
  expect(tables).toContain('submission_open_items');
  expect(tables).toContain('assumption_records');
  expect(tables).toContain('counterfactuals');
  expect(tables).toContain('raised_flags');
  expect(tables).toContain('site_visits');
  expect(tables).toContain('site_visit_floors');
  expect(tables).toContain('observations');
  expect(tables).toContain('issues');
  expect(tables).toContain('issue_observations');
  expect(tables).toContain('issue_open_items');
  expect(tables).not.toContain('users');
  expect(tables).not.toContain('roles');
  expect(tables).not.toContain('permissions');
  expect(tables).not.toContain('tenants');
});
