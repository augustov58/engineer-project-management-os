/**
 * The append-only audit record, once it covers every mutation (story 106).
 *
 * `test/memory.test.ts` still owns the memory record's own five lines and the
 * append-only assertion; what is here is the widening — that **every** route
 * that writes anything writes a line, that a refused write writes none, and
 * that the line's instant is the injected `TimeSource`'s.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  addDocument,
  addPhoto,
  createIssue,
  createObservation,
  createOpenItem,
  createPhase,
  createProject,
  createRegisterEntry,
  createSiteVisit,
  createSubmission,
  fakeTimeSource,
  handoffBody,
  listRegisters,
  reissueSubmission,
  startTestApi,
  type AuditEntryResponse,
  type TestApi,
} from './harness.js';

const started: TestApi[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((instance) => instance.close()));
});

async function api(options: Parameters<typeof startTestApi>[0] = {}) {
  const app = await startTestApi({ worker: false, ...options });
  started.push(app);
  return app;
}

async function post(app: TestApi, path: string, body?: unknown) {
  return body === undefined
    ? app.fetch(path, { method: 'POST' })
    : app.fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
}

/** The whole job's audit, oldest first — the order it was written in. */
async function trail(app: TestApi, projectId: string) {
  const response = await app.fetch(`/v1/projects/${projectId}/memory/audit`);
  expect(response.status).toBe(200);
  return (await response.json()) as AuditEntryResponse[];
}

async function actions(app: TestApi, projectId: string) {
  return (await trail(app, projectId)).map((entry) => entry.action);
}

/**
 * Every mutating route in the product, written down.
 *
 * ADR-0040 said widening the audit to every record was "its own change, not
 * something to do row by row", and this is what keeps it from becoming one
 * again: the sweep below reads the routes Fastify actually registered and
 * fails if any mutating one is missing from here. A route added later without
 * an audit line therefore fails a test rather than being noticed by somebody
 * reading a diff — the shape `edge-gate.test.ts` gives ADR-0020's gate.
 *
 * Adding a path here is a claim that the route writes a line. Both halves are
 * checked: the list may name no route the API does not register either.
 */
const AUDITED = [
  'DELETE /v1/sessions/current',
  'DELETE /v1/submissions/:id/open-items/:openItemId',
  'POST /v1/assumption-records/:id/assumptions/:line/counterfactual',
  'POST /v1/assumption-records/:id/flags/:line/open-item',
  'POST /v1/documents/:id/extractions',
  'POST /v1/documents/:id/referenced-file',
  'POST /v1/documents/:id/versions',
  'POST /v1/extractions/:id/confirm',
  'POST /v1/extractions/:id/proposal',
  'POST /v1/extractions/:id/reject',
  'POST /v1/ingest/inbound-mail',
  'POST /v1/ingested-document-files/:id/extractions',
  'POST /v1/issues/:id/close',
  'POST /v1/issues/:id/observations/:observationId',
  'POST /v1/issues/:id/open-items',
  'POST /v1/issues/:id/open-items/:openItemId',
  'POST /v1/issues/:id/reopen',
  'POST /v1/memory-proposals/:id/accept',
  'POST /v1/memory-proposals/:id/reject',
  'POST /v1/memory-runs/:id/proposal',
  'POST /v1/observations/:id/issue',
  'POST /v1/open-items/:id/reopen',
  'POST /v1/open-items/:id/resolve',
  'POST /v1/phases/:id/rename',
  'POST /v1/photos/:id/floor',
  'POST /v1/photos/:id/issue',
  'POST /v1/projects',
  'POST /v1/projects/:id/current-phase',
  'POST /v1/projects/:id/archive',
  'POST /v1/projects/:id/documents',
  'POST /v1/projects/:id/ingested-documents',
  'POST /v1/projects/:id/memory',
  'POST /v1/projects/:id/memory/runs',
  'POST /v1/projects/:id/open-items',
  'POST /v1/projects/:id/phases',
  'POST /v1/projects/:id/phases/order',
  'POST /v1/projects/:id/processing-location',
  'POST /v1/projects/:id/site-visits',
  'POST /v1/projects/:id/submissions',
  'POST /v1/register-entries/:id/disposition',
  'POST /v1/register-entries/:id/documents/:documentVersionId',
  'POST /v1/register-entries/:id/handoffs',
  'POST /v1/register-entries/:id/next-round',
  'POST /v1/register-entries/:id/open-items',
  'POST /v1/register-entries/:id/open-items/:openItemId',
  'POST /v1/register-entries/:id/response',
  'POST /v1/register-entries/:id/submission',
  'POST /v1/register-entries/:id/turnaround',
  'POST /v1/registers/:id/entries',
  'POST /v1/sessions',
  'POST /v1/site-visit-floors/:id/complete',
  'POST /v1/site-visits/:id/end',
  'POST /v1/site-visits/:id/floors',
  'POST /v1/site-visits/:id/observations',
  'POST /v1/site-visits/:id/photos',
  'POST /v1/site-visits/:id/reports',
  'POST /v1/site-visits/:id/voice-captures',
  'POST /v1/submissions/:id/assumption-records',
  'POST /v1/submissions/:id/documents/:documentVersionId',
  'POST /v1/submissions/:id/open-items',
  'POST /v1/submissions/:id/open-items/:openItemId',
  'POST /v1/submissions/:id/reissue',
  'POST /v1/users',
  'POST /v1/users/:id/disable',
  'POST /v1/voice-captures/:id/observation',
  'POST /v1/voice-captures/:id/retry',
];

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The one mutating-method route that records nothing, and why.
 *
 * `POST /v1/tools/:name` asks a helper skill a question and hands back what it
 * printed (issue #107, ADR-0053). It is a POST because its arguments are a
 * body, not because anything changes: no row is written, no stamp is set, and
 * a line saying "a helper was asked" would put a reading into an append-only
 * record of *changes*. Asking and recording are two acts, and the recording is
 * still `POST /v1/assumption-records` against a submission (ADR-0029).
 *
 * One named exception is a property a test can hold and two is the start of a
 * list — the argument `gate.md` makes for the ingest webhook, and the reason
 * this is a set with one member rather than a flag on the sweep. A second entry
 * here needs an ADR, not a line.
 */
const RECORDS_NOTHING = new Set(['POST /v1/tools/:name']);

test('every mutating route the API registers is one that writes an audit line', async () => {
  const app = await api();

  const registered = app
    .routes()
    .filter((route) => MUTATING.has(route.method))
    .map((route) => `${route.method} ${route.url}`)
    .filter((route) => !RECORDS_NOTHING.has(route))
    .sort();

  // A guard on the sweep itself, as the gate's has: if this ever collects
  // nothing, the comparison below would pass by vacuity and the widening
  // would be untested.
  expect(registered.length).toBeGreaterThan(50);
  expect(registered).toEqual([...AUDITED].sort());
});

test('the helper route is the only mutating route exempt from the audit, and it is registered', async () => {
  const app = await api();

  // The exemption may not name a route that does not exist: an entry left
  // behind after a route was renamed would silently un-gate the rename.
  const registered = new Set(
    app.routes().map((route) => `${route.method} ${route.url}`),
  );
  for (const exempt of RECORDS_NOTHING) {
    expect(registered.has(exempt)).toBe(true);
  }
  expect([...RECORDS_NOTHING]).toEqual(['POST /v1/tools/:name']);
});

/**
 * Every writer of a line, found in the source rather than driven through a
 * route (issue #111).
 *
 * The sweep above is exhaustive over *routes* and cannot be exhaustive over
 * *writers*: `POST /v1/projects/:id/submissions` and `POST /v1/submissions/
 * :id/reissue` share one call site inside `writeIssuance`, and `user reset`
 * and `user enable` are commands on the machine that no `routes()` walk will
 * ever see. Widening the line to carry a subject is a claim about all
 * sixty-seven writers, so this reads them off the disk — the shape
 * `apps/web`'s `session.test.ts` gives the rule that only one module reaches
 * the API, and for its reason: a call site that omits something paints
 * nothing and answers nothing.
 *
 * `process.cwd()` is `apps/api`: Vitest's root is the package directory
 * whether the run started here or at the repo root.
 */
const apiRoot = resolve(process.cwd());

/**
 * One `audit(tx, { … })` call, captured up to the line that closes it.
 *
 * Every one of the sixty-seven is spelled this way — there is no aliased
 * import and nothing writes `auditEntry.create` directly, both checked. The
 * closing pattern is a line carrying nothing but `});`, so a nested object or
 * a template literal spanning lines inside the call is not mistaken for its
 * end.
 */
const AUDIT_CALL = /await audit\(tx, \{([\s\S]*?)\n\s*\}\);/g;

interface CallSite {
  /** Relative to `apps/api`, e.g. `src/routes/issues.ts`. */
  path: string;
  /** The argument object's body, between the braces. */
  body: string;
}

function callSites(directory = join(apiRoot, 'src'), into: CallSite[] = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      callSites(full, into);
      continue;
    }
    if (!entry.name.endsWith('.ts')) {
      continue;
    }
    const text = readFileSync(full, 'utf8');
    for (const match of text.matchAll(AUDIT_CALL)) {
      into.push({ path: relative(apiRoot, full), body: match[1] ?? '' });
    }
  }
  return into;
}

/**
 * How many writers still pass no subject, which is what makes the expand step
 * a measurement rather than an intention.
 *
 * ADR-0055 part 4 asks for the subject at every call site "with a sweep test
 * that no line lacks one", and this is that sweep. It runs against the source
 * because the columns are nullable in the database — the lines written before
 * issue #111 touched rows nothing here now knows, and backfilling them to
 * their project would say "project" where the line was about an observation.
 * What stops a *new* line lacking one is `AuditLine`, where both fields are
 * required and `tsc` refuses a caller that omits them; this is what proves
 * that claim is true of every writer rather than of the ones a test drove.
 */
const STILL_WITHOUT_A_SUBJECT = 67;

test('every writer of an audit line is found, and the sweep says how many carry a subject', () => {
  const sites = callSites();

  // A guard on the sweep itself, as the route sweep above has: a regular
  // expression that stopped matching would pass every assertion below it by
  // finding nothing at all.
  expect(sites.length).toBeGreaterThan(60);

  const without = sites.filter((site) => !/\n\s*subject:/.test(site.body));
  expect(without.length).toBe(STILL_WITHOUT_A_SUBJECT);
});

test('a job records what happened to it, from the first line onwards', async () => {
  const app = await api();
  const project = await createProject(app, 'A-1', 'Riser replacement');
  const phase = await createPhase(app, project.id, '90% CD');
  expect((await post(app, `/v1/projects/${project.id}/current-phase`, {
    phaseId: phase.id,
  })).status).toBe(200);

  const item = await createOpenItem(app, project.id);
  const submission = await createSubmission(app, project.id, {
    openItemIds: [item.id],
  });
  await reissueSubmission(app, submission.id, { revision: 'Rev 2' });
  expect((await post(app, `/v1/open-items/${item.id}/resolve`, {
    note: 'The contractor confirmed 3050mm.',
  })).status).toBe(200);

  const walk = await createSiteVisit(app, project.id);
  const observation = await createObservation(app, walk.id);
  const issue = await createIssue(app, observation.id);
  await addPhoto(app, walk.id, { filename: `issue-${issue.number}.png` });
  expect((await post(app, `/v1/issues/${issue.id}/close`, {
    note: 'Sealed and re-inspected.',
  })).status).toBe(200);

  const [submittals] = await listRegisters(app, project.id);
  const entry = await createRegisterEntry(app, submittals!.id);
  expect((await post(app, `/v1/register-entries/${entry.id}/turnaround`, {
    turnaroundDays: 14,
  })).status).toBe(200);
  expect((await post(app, `/v1/register-entries/${entry.id}/disposition`, {
    disposition: 'Approved as Noted',
    ballInCourt: handoffBody({ party: 'Acme Mechanical', inOurCourt: false }),
  })).status).toBe(200);

  const document = await addDocument(app, project.id, {
    referencedFile: false,
  });
  expect(
    (await post(app, `/v1/documents/${document.id}/referenced-file`)).status,
  ).toBe(200);

  expect(await actions(app, project.id)).toEqual([
    'project recorded',
    'phase added',
    'current phase set',
    'open item raised',
    'submission recorded',
    'submission reissued',
    'open item resolved',
    'site visit recorded',
    'observation recorded',
    'issue raised',
    'photograph added',
    'issue closed',
    'submittal logged',
    'turnaround target set',
    'disposition recorded',
    'document recorded',
    'document marked a referenced file',
  ]);

  // Every line is on this job, and the shape has not grown a column.
  for (const entry of await trail(app, project.id)) {
    expect(entry.projectId).toBe(project.id);
    expect(Object.keys(entry).sort()).toEqual([
      'action',
      'actor',
      'createdAt',
      'detail',
      'id',
      'projectId',
      'run',
      'subject',
    ]);
    expect(entry.detail.length).toBeGreaterThan(0);
  }
});

test('the line says what happened, not only that something did', async () => {
  const app = await api();
  const project = await createProject(app, 'A-1', 'Riser replacement');
  const walk = await createSiteVisit(app, project.id);
  const observation = await createObservation(app, walk.id, {
    observed: 'Sleeve left unsealed',
    floor: '3',
    qualifier: 'Stair B',
    side: 'A',
  });
  const issue = await createIssue(app, observation.id, 'Physical / Safety');

  const written = await trail(app, project.id);
  // The location as the grammar renders it (ADR-0030), never the four
  // columns; and `Issue N`, the identifier's one format (ADR-0035).
  expect(
    written.find((line) => line.action === 'observation recorded')?.detail,
  ).toBe('Floor 3 — Stair B, Side A — Sleeve left unsealed');
  expect(written.find((line) => line.action === 'issue raised')?.detail).toBe(
    `Issue ${issue.number}, Physical / Safety`,
  );
});

test('a refused mutation writes no line, and a no-op writes none either', async () => {
  const app = await api();
  const project = await createProject(app, 'A-1', 'Riser replacement');
  const walk = await createSiteVisit(app, project.id);
  const observation = await createObservation(app, walk.id);
  await createIssue(app, observation.id);

  // Promoting the same observation twice is refused by the sighting's unique
  // index, inside the transaction the line is written in — so the number is
  // given back and the line goes with it.
  const twice = await post(app, `/v1/observations/${observation.id}/issue`, {
    category: 'Physical / Safety',
  });
  expect(twice.status).toBe(409);

  // Archiving is stamped once. The second call is a no-op and not a refusal,
  // and a line for it would say the job was archived on a day it was not.
  expect((await post(app, `/v1/projects/${project.id}/archive`)).status).toBe(200);
  expect((await post(app, `/v1/projects/${project.id}/archive`)).status).toBe(200);

  expect(await actions(app, project.id)).toEqual([
    'project recorded',
    'site visit recorded',
    'observation recorded',
    'issue raised',
    'project archived',
  ]);
});

test("a line's instant is the injected TimeSource's and never the wall clock", async () => {
  const clock = fakeTimeSource(new Date('2026-09-05T09:00:00.000Z'));
  const app = await api({ timeSource: clock });

  const project = await createProject(app, 'A-1', 'Riser replacement');
  clock.advance(3 * 60 * 60 * 1000);
  await createOpenItem(app, project.id);

  expect((await trail(app, project.id)).map((line) => line.createdAt)).toEqual([
    '2026-09-05T09:00:00.000Z',
    '2026-09-05T12:00:00.000Z',
  ]);
});
