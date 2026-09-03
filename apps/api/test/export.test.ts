import { afterEach, expect, test } from 'vitest';
import {
  A_PIXEL,
  addPhoto,
  createProject,
  createSiteVisit,
  startTestApi,
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

interface ExportBody {
  exportedAt: string;
  version: number;
  records: Record<string, unknown[]>;
}

async function exported(app: TestApi): Promise<ExportBody> {
  const response = await app.fetch('/v1/export');
  expect(response.status).toBe(200);
  return (await response.json()) as ExportBody;
}

/**
 * Every table the schema has, by the name it is exported under. Written down
 * rather than derived, because the point of the first test is to notice a
 * table that was added and never exported — and a list derived from the export
 * itself could not notice anything.
 */
const TABLES = [
  'projects',
  'projectPhases',
  'submissions',
  'submissionOpenItems',
  'openItems',
  'assumptionRecords',
  'counterfactuals',
  'raisedFlags',
  'siteVisits',
  'siteVisitFloors',
  'observations',
  'issues',
  'issueObservations',
  'issueOpenItems',
  'photos',
  'voiceCaptures',
  'siteVisitReports',
  'registers',
  'registerEntries',
  'ballInCourtEvents',
  'registerEntryOpenItems',
  'documents',
  'documentVersions',
  'submissionDocumentVersions',
  'registerEntryDocumentVersions',
  'projectMemoryVersions',
  'memoryProposals',
  'agentRuns',
  'auditEntries',
  'ingestedDocuments',
  'ingestedDocumentFiles',
  'registerEntryExtractions',
] as const;

test('an empty database still names every table', async () => {
  const app = await api();
  const body = await exported(app);

  // Present and empty, not absent. An importer reading this document should
  // not have to tell "no rows" from "this version did not have that table".
  expect(Object.keys(body.records).sort()).toEqual([...TABLES].sort());
  for (const table of TABLES) {
    expect(body.records[table]).toEqual([]);
  }
  expect(body.version).toBe(1);
});

test('the export carries the record and is dated from the injected clock', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Office fit-out');

  const body = await exported(app);
  expect(body.records['projects']).toHaveLength(1);
  expect(body.records['projects']?.[0]).toMatchObject({
    id: project.id,
    projectNumber: 'T-1',
    name: 'Office fit-out',
  });
  // The clock is injected (ADR-0022), so this is asserted rather than tolerated.
  expect(body.exportedAt).toBe(new Date(body.exportedAt).toISOString());
});

test('a storage key never reaches the export, and the path it becomes serves the bytes', async () => {
  const app = await api();
  const project = await createProject(app, 'T-2', 'Photo export');
  const walk = await createSiteVisit(app, project.id, {
    startedAt: '2026-07-23T12:30:00.000Z',
  });
  const photo = await addPhoto(app, walk.id);

  const body = await exported(app);
  const [row] = body.records['photos'] as { id: string; bytes: string }[];
  expect(row?.id).toBe(photo.id);

  // The column is replaced, not merely omitted: the export has to say the
  // file exists and where to get it, without saying how it is stored.
  expect(row?.bytes).toBe(`/v1/photos/${photo.id}/bytes`);

  // And the path it names actually serves the file — an export that pointed
  // at nothing would satisfy every assertion above.
  const bytes = await app.fetch(row?.bytes ?? '');
  expect(bytes.status).toBe(200);
  expect(Buffer.from(await bytes.arrayBuffer()).byteLength).toBe(
    Buffer.from(A_PIXEL, 'base64').byteLength,
  );
});

test('no credential and no storage key appears anywhere in the document', async () => {
  const app = await api();
  const project = await createProject(app, 'T-3', 'Secrets stay put');
  const walk = await createSiteVisit(app, project.id, {
    startedAt: '2026-07-23T12:30:00.000Z',
  });
  await addPhoto(app, walk.id);

  // Searched over the whole serialised document rather than field by field,
  // so a table added later that carries either one fails this without anybody
  // remembering to extend the test. `ingest_token` is a credential — the
  // address built from it takes mail from anyone who knows it (ADR-0042) —
  // and a `storage_key` has never reached the wire since ADR-0032.
  const raw = JSON.stringify(await exported(app));
  expect(raw).not.toContain('ingestToken');
  expect(raw).not.toContain('storageKey');
  expect(raw).not.toContain('storage_key');
});
