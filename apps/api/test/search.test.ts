/**
 * Keyword search across every job (issue #66, ADR-0067).
 *
 * The first escalation ADR-0019 names — keyword search, when a corpus
 * outgrows reading — and nothing past it: no embedding, no vector, no
 * similarity between records. Every test drives `GET /v1/search` and reads
 * the answer; the records are built through the API as everywhere else.
 */

import { afterEach, expect, test } from 'vitest';
import {
  type TestApi,
  addDocument,
  addIngestedDocument,
  createAssumptionRecord,
  createIssue,
  createObservation,
  createOpenItem,
  createPhase,
  createProject,
  createRegisterEntry,
  createSiteVisit,
  createSubmission,
  fakeOcrProvider,
  listRegisters,
  startTestApi,
  until,
  writeMemory,
} from './harness.js';
import { EXTRACTION_TEXT_MAX } from '../src/worker.js';

const started: TestApi[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((api) => api.close()));
});

async function api(options?: Parameters<typeof startTestApi>[0]) {
  const app = await startTestApi(options);
  started.push(app);
  return app;
}

interface SearchResult {
  kind: string;
  id: string;
  projectId: string;
  projectNumber: string;
  projectName: string;
  archived: boolean;
  title: string;
  excerpt: string | null;
  linkId: string;
}

async function search(app: TestApi, q: string) {
  const response = await app.fetch(`/v1/search?q=${encodeURIComponent(q)}`);
  expect(response.status, q).toBe(200);
  return ((await response.json()) as { results: SearchResult[] }).results;
}

/** Where a match is, as the screen will show it: the markers made visible. */
function marked(excerpt: string | null) {
  return (excerpt ?? '').replaceAll('\u0002', '[').replaceAll('\u0003', ']');
}

test('every kind of record is found by a word in it, and says where it opens', async () => {
  const app = await api();
  const project = await createProject(app, 'S-1', 'Harbour pumping station');

  await createOpenItem(app, project.id, {
    unresolved: 'Wet well lid clearance for the gantry',
  });
  const phase = await createPhase(app, project.id, '90% CD');
  const submission = await createSubmission(app, project.id, {
    phaseId: phase.id,
    sheetList: 'M-101 gantry rail layout',
  });
  await createAssumptionRecord(app, submission.id, {
    codeEdition: 'NEC 2023 turbidity annex',
  });
  const walk = await createSiteVisit(app, project.id);
  const seen = await createObservation(app, walk.id, {
    observed: 'Efflorescence on the east wall below the louvre',
  });
  const finding = await createIssue(app, seen.id);
  await createObservation(app, walk.id, {
    observed: 'Spalling at the pump plinth edge',
  });
  const [register] = await listRegisters(app, project.id);
  const entry = await createRegisterEntry(app, register!.id, {
    subject: 'Impeller casing coating',
  });
  await addDocument(app, project.id, { title: 'Hydraulic profile sheet set' });
  await addIngestedDocument(app, project.id, {
    note: 'Forwarded by the operator: sluice gate actuator datasheet',
  });
  await writeMemory(app, project.id, 'The client prefers stainless penstock frames.');

  const expectations: [string, string, string][] = [
    ['clearance', 'open-item', project.id],
    ['rail', 'submission', submission.id],
    ['turbidity', 'assumption-record', submission.id],
    // A sighting opens on its finding, by the number a person has written
    // down (ADR-0031); an observation that stayed one opens on its walk.
    ['efflorescence', 'issue', String(finding.number)],
    ['spalling', 'observation', walk.id],
    ['impeller', 'register-entry', entry.id],
    ['hydraulic', 'document', project.id],
    ['sluice', 'arrival', project.id],
    ['penstock', 'memory', project.id],
    ['harbour', 'project', project.id],
  ];
  for (const [word, kind, linkId] of expectations) {
    const results = await search(app, word);
    expect(
      results.map((one) => [one.kind, one.linkId]),
      word,
    ).toContainEqual([kind, linkId]);
    const hit = results.find((one) => one.kind === kind)!;
    expect(hit.projectId).toBe(project.id);
    expect(hit.projectNumber).toBe('S-1');
    expect(hit.archived).toBe(false);
  }
});

test('words match by their stem, a phrase by its order, and the match is marked in the excerpt', async () => {
  const app = await api();
  const project = await createProject(app, 'S-2', 'Clinic');
  await createOpenItem(app, project.id, {
    unresolved: 'Basement flooding after the storm',
  });

  // English stemming: *flooded* finds *flooding*.
  const [hit] = await search(app, 'flooded');
  expect(hit?.kind).toBe('open-item');
  expect(marked(hit!.excerpt)).toContain('[flooding]');

  // A quoted phrase is words in order, not the words anywhere.
  expect(await search(app, '"storm basement"')).toEqual([]);
  expect((await search(app, '"basement flooding"')).map((one) => one.kind)).toEqual([
    'open-item',
  ]);
});

test('search runs across every job, archived ones included and said to be', async () => {
  const app = await api();
  const live = await createProject(app, 'S-3', 'Live job');
  const done = await createProject(app, 'S-4', 'Finished job');
  await createOpenItem(app, live.id, { unresolved: 'Parapet capstone detail' });
  await createOpenItem(app, done.id, { unresolved: 'Parapet flashing detail' });
  const archived = await app.fetch(`/v1/projects/${done.id}/archive`, { method: 'POST' });
  expect(archived.status).toBe(200);

  const results = await search(app, 'parapet');
  expect(
    results.map((one) => [one.projectNumber, one.archived]).sort(),
  ).toEqual([
    ['S-3', false],
    ['S-4', true],
  ]);
});

test('only what the memory says now is found, not what it used to say', async () => {
  const app = await api();
  const project = await createProject(app, 'S-5', 'Memory job');
  await writeMemory(app, project.id, 'The owner wants cedar cladding.');
  await writeMemory(app, project.id, 'The owner wants zinc cladding.');

  expect(await search(app, 'cedar')).toEqual([]);
  expect((await search(app, 'zinc')).map((one) => one.kind)).toEqual(['memory']);
});

test('an extraction is found by what the OCR read, and OCR text past the bound is stored and not searched', async () => {
  // The size this rule exists for (ADR-0052). The search column reads the
  // first EXTRACTION_TEXT_MAX characters of `ocr_text`: Postgres refuses a
  // tsvector over 1 MB, and a generated column over the whole of a
  // 2,000-page document would refuse the **store** — which is the extraction
  // failing, not the search.
  const head = 'Specification for the wastewater membrane bioreactor. ';
  const filler = 'lorem ipsum dolor sit amet '.repeat(
    Math.ceil(EXTRACTION_TEXT_MAX / 27),
  );
  // Past the bound, 140,000 distinct words: over 1 MB of tsvector on their
  // own, so without the bound on the column this row could not be stored.
  const tail = Array.from({ length: 140_000 }, (_, i) => `w${i.toString(36)}`).join(' ');
  const text = `${`${head}${filler}`.slice(0, EXTRACTION_TEXT_MAX)} quarantined ${tail}`;
  const app = await api({ ocr: fakeOcrProvider(text) });
  const project = await createProject(app, 'S-6', 'Treatment works');
  const document = await addDocument(app, project.id, {
    title: 'Process spec',
    referencedFile: false,
  });

  const asked = await app.fetch(`/v1/documents/${document.id}/extractions`, {
    method: 'POST',
  });
  expect(asked.status).toBe(201);
  const { id } = (await asked.json()) as { id: string };

  // Past the bound the run fails (issue #132) — and the text was stored
  // whole first, which the generated column must not have stopped.
  const failed = await until(async () => {
    const response = await app.fetch(`/v1/extractions/${id}`);
    const row = (await response.json()) as { failedAt: string | null; ocrText: string | null };
    return row.failedAt === null ? undefined : row;
  }, `extraction ${id} to fail`);
  expect(failed.ocrText).toHaveLength(text.length);

  const found = await search(app, 'bioreactor');
  expect(found.map((one) => [one.kind, one.linkId])).toEqual([['extraction', id]]);
  expect(marked(found[0]!.excerpt)).toContain('[bioreactor]');
  // A word past the first EXTRACTION_TEXT_MAX characters is not searched.
  expect(await search(app, 'quarantined')).toEqual([]);
});

test('a query is refused when empty or too long, and one of stop words alone finds nothing', async () => {
  const app = await api();
  expect((await app.fetch('/v1/search?q=')).status).toBe(400);
  expect((await app.fetch('/v1/search')).status).toBe(400);
  expect(
    (await app.fetch(`/v1/search?q=${'a'.repeat(201)}`)).status,
  ).toBe(400);
  expect(await search(app, 'the and of')).toEqual([]);
});
