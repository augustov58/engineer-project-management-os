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
  expect(tables).toContain('photos');
  expect(tables).toContain('registers');
  expect(tables).toContain('register_entries');
  expect(tables).toContain('ball_in_court_events');
  expect(tables).toContain('register_entry_open_items');
  expect(tables).toContain('documents');
  expect(tables).toContain('document_versions');
  expect(tables).toContain('submission_document_versions');
  expect(tables).toContain('register_entry_document_versions');
  expect(tables).toContain('project_memory_versions');
  expect(tables).toContain('memory_proposals');
  expect(tables).toContain('agent_runs');
  expect(tables).toContain('audit_entries');
  expect(tables).not.toContain('users');
  expect(tables).not.toContain('roles');
  expect(tables).not.toContain('permissions');
  expect(tables).not.toContain('tenants');

  // ADR-0019: no vector search, and no keyword index either — retrieval is by
  // identity. Issue #17 is the first slice that could have wanted one, since
  // it is the first that stores a corpus. Only a table can be seen from here;
  // a `tsvector` column and a GIN index cannot, and widening what this test
  // may read is not worth the one thing it would add.
  expect(tables).not.toContain('embeddings');
  expect(tables).not.toContain('document_embeddings');
  expect(tables).not.toContain('search_index');
});
