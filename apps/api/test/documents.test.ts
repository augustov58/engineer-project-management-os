import { afterEach, expect, test } from 'vitest';
import {
  A_PAGE,
  addDocument,
  addDocumentVersion,
  createPhase,
  createProject,
  createRegisterEntry,
  createSubmission,
  documentBody,
  documentVersionBody,
  listRegisters,
  startTestApi,
  type DocumentResponse,
  type LinkedDocumentVersion,
  type ProjectResponse,
  type RegisterEntryResponse,
  type SubmissionResponse,
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

async function documentsOn(app: TestApi, projectId: string) {
  const response = await app.fetch(`/v1/projects/${projectId}/documents`);
  expect(response.status).toBe(200);
  return (await response.json()) as DocumentResponse[];
}

async function extractionTargets(app: TestApi, projectId: string) {
  const path = `/v1/projects/${projectId}/extraction-targets`;
  const response = await app.fetch(path);
  expect(response.status).toBe(200);
  return (await response.json()) as DocumentResponse[];
}

async function linkedTo(app: TestApi, path: string) {
  const response = await app.fetch(path);
  expect(response.status).toBe(200);
  return (await response.json()) as LinkedDocumentVersion[];
}

/** A job with one issuance on it, which is what a sheet list needs. */
async function issued(
  app: TestApi,
  projectNumber: string,
): Promise<{ project: ProjectResponse; submission: SubmissionResponse }> {
  const project = await createProject(app, projectNumber, 'Warehouse fit-out');
  const phase = await createPhase(app, project.id, '90% CD');
  const submission = await createSubmission(app, project.id, {
    phaseId: phase.id,
  });
  return { project, submission };
}

/** A job with one entry in its submittals log. */
async function logged(
  app: TestApi,
  projectNumber: string,
): Promise<{ project: ProjectResponse; entry: RegisterEntryResponse }> {
  const project = await createProject(app, projectNumber, 'Warehouse fit-out');
  const [submittals] = await listRegisters(app, project.id);
  if (submittals === undefined) {
    throw new Error('fixture failed: a project has two registers');
  }
  const entry = await createRegisterEntry(app, submittals.id);
  return { project, entry };
}

// ── Storing a document against a project ─────────────────────────────────

test('a document is recorded against a project with its first version', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Office fit-out');

  const response = await post(
    app,
    `/v1/projects/${project.id}/documents`,
    documentBody({ title: 'Electrical drawing set' }),
  );
  expect(response.status).toBe(201);
  const document = (await response.json()) as DocumentResponse;

  // The exact key set, so a column cannot be added to what a document is
  // without a failing test saying so — and so the storage key cannot start
  // reaching the wire.
  expect(Object.keys(document).sort()).toEqual([
    'createdAt',
    'id',
    'projectId',
    'referencedFile',
    'title',
    'versions',
  ]);
  expect(document.projectId).toBe(project.id);
  expect(document.title).toBe('Electrical drawing set');
  expect(document.referencedFile).toBe(true);

  expect(document.versions).toHaveLength(1);
  const [first] = document.versions;
  expect(Object.keys(first ?? {}).sort()).toEqual([
    'byteSize',
    'contentType',
    'createdAt',
    'documentId',
    'filename',
    'id',
    'revision',
  ]);
  expect(first?.revision).toBe('C');
  expect(first?.filename).toBe('T-1 Electrical.pdf');
  expect(first?.contentType).toBe('application/pdf');
  expect(first?.byteSize).toBe(Buffer.from(A_PAGE, 'base64').byteLength);
});

test('a document on a project that does not exist is a 404', async () => {
  const app = await api();
  const response = await post(
    app,
    `/v1/projects/${NO_SUCH}/documents`,
    documentBody(),
  );
  expect(response.status).toBe(404);
});

test('a document is recorded with its version or not at all', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Office fit-out');
  const path = `/v1/projects/${project.id}/documents`;

  // Named in the same call that records the document, so a document is never
  // a title with no bytes.
  const bodiless = await post(app, path, {
    title: 'Electrical drawing set',
    referencedFile: true,
  });
  expect(bodiless.status).toBe(400);

  // Whether it is a referenced file is not a default. A document that
  // arrived unclassified would be an extraction target by omission, which
  // is the liability this ticket exists to refuse.
  const unclassified = await post(app, path, {
    title: 'Electrical drawing set',
    version: documentVersionBody(),
  });
  expect(unclassified.status).toBe(400);

  expect(await documentsOn(app, project.id)).toEqual([]);
});

test.each([
  ['a blank title', documentBody({ title: '   ' })],
  ['a blank revision', documentBody({ version: { revision: '  ' } })],
  ['a blank filename', documentBody({ version: { filename: ' ' } })],
  [
    'a type outside the closed set',
    documentBody({ version: { contentType: 'text/html' } }),
  ],
  ['no bytes at all', documentBody({ version: { bytes: '' } })],
])('%s is refused at the boundary', async (_name, body) => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Office fit-out');

  const response = await post(
    app,
    `/v1/projects/${project.id}/documents`,
    body,
  );
  expect(response.status).toBe(400);
  expect(await documentsOn(app, project.id)).toEqual([]);
});

test('a body that is not whole base64 is refused, not truncated', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Office fit-out');

  // One character past a whole quartet. `Buffer.from` does not refuse this —
  // it silently drops the trailing character — so a looser pattern would have
  // stored a short file and answered 201, and nothing downstream could tell.
  const response = await post(
    app,
    `/v1/projects/${project.id}/documents`,
    documentBody({ version: { bytes: `${A_PAGE}x` } }),
  );
  expect(response.status).toBe(400);
  expect(await documentsOn(app, project.id)).toEqual([]);

  // The whole string still passes, and stores every byte of it.
  const whole = await addDocument(app, project.id);
  expect(whole.versions[0]?.byteSize).toBe(
    Buffer.from(A_PAGE, 'base64').byteLength,
  );
});

test('the storage key never reaches the wire', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Office fit-out');
  await addDocument(app, project.id);

  const response = await app.fetch(`/v1/projects/${project.id}/documents`);
  expect(response.status).toBe(200);
  // Read as text, so a key nested anywhere in the payload is caught rather
  // than only one on the shape the assertions above name.
  expect(await response.text()).not.toContain('documents/');
});

// ── A version is immutable, and a new one never overwrites a prior ────────

test('a second version leaves the first standing', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Office fit-out');
  const document = await addDocument(app, project.id, {
    version: { revision: 'C' },
  });
  const [firstVersion] = document.versions;

  const withSecond = await addDocumentVersion(app, document.id, {
    revision: 'D',
    filename: 'T-1 Electrical Rev D.pdf',
  });

  expect(withSecond.versions).toHaveLength(2);
  // Byte for byte what it was, including its id: a new version is a new row
  // and writes nothing at all to the one it follows.
  expect(withSecond.versions[0]).toEqual(firstVersion);
  expect(withSecond.versions[1]?.revision).toBe('D');
});

test('a revision already on the document is refused', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Office fit-out');
  const document = await addDocument(app, project.id, {
    version: { revision: 'C' },
  });

  const response = await post(
    app,
    `/v1/documents/${document.id}/versions`,
    documentVersionBody({ revision: 'C' }),
  );
  expect(response.status).toBe(409);

  const [only] = await documentsOn(app, project.id);
  expect(only?.versions).toHaveLength(1);
});

test('the same revision on another document is fine', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Office fit-out');
  const drawings = await addDocument(app, project.id, {
    title: 'Electrical drawing set',
  });
  const specs = await addDocument(app, project.id, {
    title: 'Division 26 specification',
  });

  expect(drawings.versions[0]?.revision).toBe('C');
  expect(specs.versions[0]?.revision).toBe('C');
});

test('a version of a document that does not exist is a 404', async () => {
  const app = await api();
  const response = await post(
    app,
    `/v1/documents/${NO_SUCH}/versions`,
    documentVersionBody(),
  );
  expect(response.status).toBe(404);
});

test.each(['PATCH', 'PUT', 'DELETE'])(
  'nothing edits a document: %s is refused',
  async (method) => {
    const app = await api();
    const project = await createProject(app, `X-${method}`, 'Office fit-out');
    const document = await addDocument(app, project.id);

    const carries = method !== 'DELETE';
    const response = await app.fetch(`/v1/documents/${document.id}`, {
      method,
      ...(carries
        ? { headers: json, body: JSON.stringify({ referencedFile: false }) }
        : {}),
    });
    expect(response.status, method).toBe(404);

    expect(await documentsOn(app, project.id)).toEqual([document]);
  },
);

test.each(['PATCH', 'PUT', 'DELETE'])(
  'nothing edits a version: %s is refused',
  async (method) => {
    const app = await api();
    const project = await createProject(app, `Y-${method}`, 'Office fit-out');
    const document = await addDocument(app, project.id);
    const [version] = document.versions;

    const carries = method !== 'DELETE';
    const response = await app.fetch(`/v1/document-versions/${version?.id}`, {
      method,
      ...(carries
        ? { headers: json, body: JSON.stringify({ revision: 'D' }) }
        : {}),
    });
    expect(response.status, method).toBe(404);

    expect(await documentsOn(app, project.id)).toEqual([document]);
  },
);

// ── The bytes live in the object store ───────────────────────────────────

test('every version serves back the bytes it was given', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Office fit-out');
  const document = await addDocument(app, project.id, {
    version: { revision: 'C', bytes: A_PAGE },
  });

  const other = Buffer.from('%PDF-1.7\nrevision D\n%%EOF\n').toString('base64');
  const withSecond = await addDocumentVersion(app, document.id, {
    revision: 'D',
    bytes: other,
  });

  const [first, second] = withSecond.versions;
  const older = await app.fetch(`/v1/document-versions/${first?.id}/bytes`);
  expect(older.status).toBe(200);
  expect(older.headers.get('content-type')).toBe('application/pdf');
  expect(older.headers.get('x-content-type-options')).toBe('nosniff');
  expect(Buffer.from(await older.arrayBuffer())).toEqual(
    Buffer.from(A_PAGE, 'base64'),
  );

  const newer = await app.fetch(`/v1/document-versions/${second?.id}/bytes`);
  expect(newer.status).toBe(200);
  expect(Buffer.from(await newer.arrayBuffer())).toEqual(
    Buffer.from(other, 'base64'),
  );
});

test('the bytes of no version are a 404', async () => {
  const app = await api();
  const response = await app.fetch(`/v1/document-versions/${NO_SUCH}/bytes`);
  expect(response.status).toBe(404);
});

// ── A referenced file is never an extraction target ──────────────────────

// What these prove: the list the enqueuer reads excludes a referenced file,
// and the enqueuer itself — `POST /documents/:id/extractions`, arrived with
// issue #20 — refuses one, so "a referenced file is never enqueued" holds at
// the write as well as at the read (ADR-0043). The enqueue's own behaviour is
// extraction's ticket and lives in extractions.test.ts; what survives here is
// the property: a referenced file is not in the list, and cannot be sent.

test('a referenced file is never an extraction target', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Office fit-out');

  const drawings = await addDocument(app, project.id, {
    title: 'Electrical drawing set',
    referencedFile: true,
  });
  const transmittal = await addDocument(app, project.id, {
    title: 'Transmittal 004',
    referencedFile: false,
  });

  // Both are stored, linked and retrievable; only one is something
  // extraction would ever be pointed at.
  expect(await documentsOn(app, project.id)).toEqual([drawings, transmittal]);
  expect(await extractionTargets(app, project.id)).toEqual([transmittal]);

  // And the enqueuer itself refuses it (the write half of the same fact).
  const refused = await post(app, `/v1/documents/${drawings.id}/extractions`);
  expect(refused.status).toBe(409);
});

test('a version added to a referenced file is no more of a target', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Office fit-out');
  const drawings = await addDocument(app, project.id, { referencedFile: true });

  await addDocumentVersion(app, drawings.id, { revision: 'D' });

  expect(await extractionTargets(app, project.id)).toEqual([]);
});

test('a document is marked a referenced file after the fact', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Office fit-out');
  const misfiled = await addDocument(app, project.id, {
    title: 'Electrical drawing set',
    referencedFile: false,
  });
  expect(await extractionTargets(app, project.id)).toEqual([misfiled]);

  const response = await post(
    app,
    `/v1/documents/${misfiled.id}/referenced-file`,
  );
  expect(response.status).toBe(200);
  expect(((await response.json()) as DocumentResponse).referencedFile).toBe(
    true,
  );

  // Out of extraction's reach, and everything else about it untouched.
  expect(await extractionTargets(app, project.id)).toEqual([]);
  const [stored] = await documentsOn(app, project.id);
  expect(stored).toEqual({ ...misfiled, referencedFile: true });
});

test('marking runs one way and never back', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Office fit-out');
  const drawings = await addDocument(app, project.id, { referencedFile: true });

  // Refused rather than repeated, as a response and a disposition are. There
  // is no route at all that sets the column false: a correction may take a
  // document out of extraction's reach and may never put one into it.
  const again = await post(
    app,
    `/v1/documents/${drawings.id}/referenced-file`,
  );
  expect(again.status).toBe(409);

  for (const method of ['PATCH', 'PUT', 'DELETE']) {
    const response = await app.fetch(
      `/v1/documents/${drawings.id}/referenced-file`,
      { method },
    );
    expect(response.status, method).toBe(404);
  }

  expect(await extractionTargets(app, project.id)).toEqual([]);
});

test('marking a document that does not exist is a 404', async () => {
  const app = await api();
  const response = await post(
    app,
    `/v1/documents/${NO_SUCH}/referenced-file`,
  );
  expect(response.status).toBe(404);
});

test('the extraction targets of a project that does not exist is a 404', async () => {
  const app = await api();
  const response = await app.fetch(
    `/v1/projects/${NO_SUCH}/extraction-targets`,
  );
  expect(response.status).toBe(404);
});

// ── Retrieval by the structure the document belongs to ───────────────────

test("a project's documents are its own", async () => {
  const app = await api();
  const one = await createProject(app, 'T-1', 'Office fit-out');
  const two = await createProject(app, 'T-2', 'Warehouse fit-out');

  const ours = await addDocument(app, one.id, { title: 'T-1 drawings' });
  await addDocument(app, two.id, { title: 'T-2 drawings' });

  expect(await documentsOn(app, one.id)).toEqual([ours]);
});

test("the documents of a project that does not exist is a 404", async () => {
  const app = await api();
  const response = await app.fetch(`/v1/projects/${NO_SUCH}/documents`);
  expect(response.status).toBe(404);
});

// ── Linking a referenced file to a submission's sheet list ───────────────

test("a referenced file links to a submission and edits nothing on it", async () => {
  const app = await api();
  const { project, submission } = await issued(app, 'T-1');
  const document = await addDocument(app, project.id);
  const [version] = document.versions;

  const link = await post(
    app,
    `/v1/submissions/${submission.id}/documents/${version?.id}`,
  );
  expect(link.status).toBe(204);

  const linked = await linkedTo(app, `/v1/submissions/${submission.id}/documents`);
  expect(linked).toHaveLength(1);
  expect(linked[0]?.id).toBe(version?.id);
  expect(linked[0]?.document.title).toBe(document.title);
  expect(linked[0]?.document.referencedFile).toBe(true);

  // The defined set points at the actual document, and the issuance itself
  // is untouched — its sheet list is the text it went out with.
  const read = await app.fetch(`/v1/submissions/${submission.id}`);
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({ ...submission });
});

test('the same version is not linked to one submission twice', async () => {
  const app = await api();
  const { project, submission } = await issued(app, 'T-1');
  const document = await addDocument(app, project.id);
  const path = `/v1/submissions/${submission.id}/documents/${document.versions[0]?.id}`;

  expect((await post(app, path)).status).toBe(204);
  expect((await post(app, path)).status).toBe(409);

  expect(
    await linkedTo(app, `/v1/submissions/${submission.id}/documents`),
  ).toHaveLength(1);
});

test("a version on another job is not this submission's to point at", async () => {
  const app = await api();
  const { submission } = await issued(app, 'T-1');
  const other = await createProject(app, 'T-2', 'Warehouse fit-out');
  const theirs = await addDocument(app, other.id);

  const response = await post(
    app,
    `/v1/submissions/${submission.id}/documents/${theirs.versions[0]?.id}`,
  );
  expect(response.status).toBe(409);
});

test('linking to a submission or a version that does not exist is a 404', async () => {
  const app = await api();
  const { project, submission } = await issued(app, 'T-1');
  const document = await addDocument(app, project.id);

  const noSet = await post(
    app,
    `/v1/submissions/${NO_SUCH}/documents/${document.versions[0]?.id}`,
  );
  expect(noSet.status).toBe(404);

  const noVersion = await post(
    app,
    `/v1/submissions/${submission.id}/documents/${NO_SUCH}`,
  );
  expect(noVersion.status).toBe(404);

  const noList = await app.fetch(`/v1/submissions/${NO_SUCH}/documents`);
  expect(noList.status).toBe(404);
});

// ── Linking a document to a register entry ───────────────────────────────

test('a document links to a register entry and reads back through it', async () => {
  const app = await api();
  const { project, entry } = await logged(app, 'T-1');
  const document = await addDocument(app, project.id, {
    title: 'Rooftop unit submittal package',
    referencedFile: false,
  });
  const [version] = document.versions;

  const link = await post(
    app,
    `/v1/register-entries/${entry.id}/documents/${version?.id}`,
  );
  expect(link.status).toBe(204);

  const linked = await linkedTo(
    app,
    `/v1/register-entries/${entry.id}/documents`,
  );
  expect(linked).toHaveLength(1);
  expect(linked[0]?.id).toBe(version?.id);
  expect(linked[0]?.document.title).toBe('Rooftop unit submittal package');

  expect((await post(app, `/v1/register-entries/${entry.id}/documents/${version?.id}`)).status).toBe(409);
});

test("a version on another job is not this entry's to point at", async () => {
  const app = await api();
  const { entry } = await logged(app, 'T-1');
  const other = await createProject(app, 'T-2', 'Warehouse fit-out');
  const theirs = await addDocument(app, other.id);

  const response = await post(
    app,
    `/v1/register-entries/${entry.id}/documents/${theirs.versions[0]?.id}`,
  );
  expect(response.status).toBe(409);
});

test('linking to a register entry or a version that does not exist is a 404', async () => {
  const app = await api();
  const { project, entry } = await logged(app, 'T-1');
  const document = await addDocument(app, project.id);

  const noEntry = await post(
    app,
    `/v1/register-entries/${NO_SUCH}/documents/${document.versions[0]?.id}`,
  );
  expect(noEntry.status).toBe(404);

  const noVersion = await post(
    app,
    `/v1/register-entries/${entry.id}/documents/${NO_SUCH}`,
  );
  expect(noVersion.status).toBe(404);

  const noList = await app.fetch(`/v1/register-entries/${NO_SUCH}/documents`);
  expect(noList.status).toBe(404);
});

test('one version answers for the issuance and the entry it went out on', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Office fit-out');
  const phase = await createPhase(app, project.id, '90% CD');
  const submission = await createSubmission(app, project.id, {
    phaseId: phase.id,
  });
  const [submittals] = await listRegisters(app, project.id);
  const entry = await createRegisterEntry(app, submittals?.id ?? '');

  const document = await addDocument(app, project.id);
  const [version] = document.versions;

  // One document, reached from two structures. Retrieval is by identity, so
  // neither read depends on remembering what the file was called.
  expect(
    (
      await post(
        app,
        `/v1/submissions/${submission.id}/documents/${version?.id}`,
      )
    ).status,
  ).toBe(204);
  expect(
    (
      await post(
        app,
        `/v1/register-entries/${entry.id}/documents/${version?.id}`,
      )
    ).status,
  ).toBe(204);

  const bySet = await linkedTo(
    app,
    `/v1/submissions/${submission.id}/documents`,
  );
  const byEntry = await linkedTo(
    app,
    `/v1/register-entries/${entry.id}/documents`,
  );
  expect(bySet).toEqual(byEntry);
});
