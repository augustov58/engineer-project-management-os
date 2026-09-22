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
  requestMemoryRun,
  startTestApi,
  until,
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
  'POST /v1/assumption-record-runs/:id/proposal',
  'POST /v1/capture-runs/:id/proposal',
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
  'POST /v1/open-items/:id/owner',
  'POST /v1/open-items/:id/reopen',
  'POST /v1/open-items/:id/resolve',
  'POST /v1/phases/:id/rename',
  'POST /v1/photos/:id/floor',
  'POST /v1/photos/:id/issue',
  'POST /v1/photos/:id/observation',
  'POST /v1/projects',
  'POST /v1/conversations/:id/turns',
  'POST /v1/projects/:id/current-phase',
  'POST /v1/projects/:id/archive',
  'POST /v1/projects/:id/conversations',
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
  'POST /v1/site-visits/:id/conducted-by',
  'POST /v1/site-visits/:id/end',
  'POST /v1/site-visits/:id/floors',
  'POST /v1/site-visits/:id/observations',
  'POST /v1/site-visits/:id/photos',
  'POST /v1/site-visits/:id/reports',
  'POST /v1/site-visits/:id/turns',
  'POST /v1/submissions/:id/assumption-records',
  'POST /v1/submissions/:id/documents/:documentVersionId',
  'POST /v1/submissions/:id/open-items',
  'POST /v1/submissions/:id/open-items/:openItemId',
  'POST /v1/submissions/:id/reissue',
  'POST /v1/turns/:id/observation',
  'POST /v1/turns/:id/retry',
  'POST /v1/users',
  'POST /v1/users/:id/disable',
  'POST /v1/users/current/theme',
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
 * ever see. Widening the line to carry a subject is a claim about **every**
 * writer, so this reads them off the disk — the shape
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
 * Every one of them is spelled this way — there is no aliased import and
 * nothing writes `auditEntry.create` directly, both checked. The
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
 * No writer lacks an actor or a subject — the sweep ADR-0055 part 4 asks for.
 *
 * It runs against the source because the columns are nullable in the database:
 * the lines written before issue #111 touched rows nothing here now knows, and
 * backfilling them to their project would say "project" where the line was
 * about an observation, which is a wrong answer rather than a missing one. So
 * the guarantee is not `NOT NULL` but `AuditLine`, where both fields are
 * required and `tsc` refuses a caller that omits them — and this is what turns
 * that into a statement about every writer rather than about the ones a test
 * happened to drive.
 *
 * It also catches what `tsc` cannot: an `audit()` reached through a wrapper
 * that supplies its own actor, which would typecheck and would quietly take
 * the answer away from the boundary.
 */
test('no writer of an audit line lacks an actor or a subject', () => {
  const sites = callSites();

  // A guard on the sweep itself, as the route sweep above has: a regular
  // expression that stopped matching would pass every assertion below it by
  // finding nothing at all.
  expect(sites.length).toBeGreaterThan(60);

  expect(
    sites.filter((site) => !/\n\s*subject:/.test(site.body)).map((s) => s.path),
  ).toEqual([]);
  expect(
    sites.filter((site) => !/\n\s*actor[,:]/.test(site.body)).map((s) => s.path),
  ).toEqual([]);
});

/**
 * The actor is read at the boundary and never taken off a request body
 * (ADR-0055 part 4). `actorOf` is the one function that builds one from a
 * request, and a route that spelled `request.body.actor` would typecheck
 * perfectly.
 *
 * `routes/sessions.ts` is the one file that composes an actor itself, and it
 * has to: signing in is the act of getting a session, so its caller has been
 * authenticated and has none yet. It reads the account it just verified, which
 * is what `actorOf` reads everywhere else.
 */
test('nothing builds an actor out of a request body', () => {
  const composing = callSites()
    .filter((site) => /actor: \{/.test(site.body))
    .map((site) => site.path);

  expect([...new Set(composing)]).toEqual(['src/routes/sessions.ts']);

  for (const site of callSites()) {
    expect(site.body).not.toMatch(/actor:.*request\.body/);
  }
});

/**
 * Every place a line goes unattributed, named — one route and three commands.
 *
 * `NO_ACTOR` exists so that an actorless line reads as a decision at the call
 * site rather than as an omission, and this is what makes that decision
 * reviewable: the constant is greppable, so the set of places that use it is a
 * fact a test can hold. It was written because the prose got it wrong — three
 * doc comments in issue #111 said "three places and no more" and missed
 * `user create`, which is actorless for the plainest reason there is: the
 * first account is made before anybody exists to record it against.
 *
 * `user create` is the one of the four that is not *always* actorless. The
 * same `createUser` serves `POST /v1/users`, where a signed-in engineer adds
 * the next account and the actor is a parameter — which is why the constant is
 * spelled in `user-command.ts` and not in the leaf.
 */
test('a line goes unattributed in one route and three commands, and nowhere else', () => {
  const uses: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) {
        continue;
      }
      for (const line of readFileSync(full, 'utf8').split('\n')) {
        const code = line.trim();
        // An import, the declaration itself and prose about it are not uses.
        if (
          !/\bNO_ACTOR\b/.test(code) ||
          code.startsWith('import') ||
          code.startsWith('export const NO_ACTOR') ||
          code.startsWith('*') ||
          code.startsWith('//')
        ) {
          continue;
        }
        uses.push(relative(apiRoot, full));
      }
    }
  };
  walk(join(apiRoot, 'src'));

  expect(uses.sort()).toEqual([
    // The one route the gate lets through: a provider posts to an address it
    // was given and presents nothing (ADR-0042).
    'src/routes/ingest.ts',
    // `user create` — the first account, made before anybody exists.
    'src/user-command.ts',
    // `user reset` and `user enable`, the floor under a deployment nobody can
    // sign in to through the interface.
    'src/users.ts',
    'src/users.ts',
  ]);
});

/**
 * No model gains a `created_by` (ADR-0055 part 4).
 *
 * "Who recorded this" is a read of the audit, which is ADR-0048's rule applied
 * to authorship: a column on each of thirty-odd models would be that many
 * copies of a fact one table already holds in the same transaction as the
 * write it describes, and the copies would be free to disagree with it.
 *
 * Read off `schema.prisma` rather than out of `information_schema`, so it
 * stays clear of ADR-0012's sanctioned exception, which `test/schema.test.ts`
 * holds to table names and nothing else.
 */
test('no model carries an author of its own', () => {
  const schema = readFileSync(join(apiRoot, 'prisma/schema.prisma'), 'utf8');
  // Prose stripped first: the rule is about columns, and the documentation on
  // `audit_entries.actor_id` says the word in order to say why no model
  // carries it.
  const columns = schema
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  expect(columns).not.toMatch(/createdBy|created_by/);
  expect(columns).not.toMatch(/authorId|author_id/);

  // The one place an author lives, so the assertions above are a rule about
  // where it is and not a rule that it is nowhere.
  expect(columns).toMatch(/actorId String\? +@map\("actor_id"\)/);
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

// ── Who, and which row (issue #111) ──────────────────────────────────────

test('a line says who wrote it, by name and not only by id', async () => {
  const app = await api();
  const project = await createProject(app, 'A-1', 'Riser replacement');

  const [recorded] = await trail(app, project.id);
  expect(recorded).toBeDefined();
  // The account the harness signed in as, which is whose session every call
  // above carried. The name and not only the id: "who recorded this" is a
  // question somebody asks of a screen.
  expect(recorded?.actor).toEqual({ id: app.user.id, name: app.user.name });
  // Nobody was acting inside a run, so there is no run to name.
  expect(recorded?.run).toBeNull();
});

test('a line names the row it is about, and never a session', async () => {
  const app = await api();
  const project = await createProject(app, 'A-1', 'Riser replacement');
  const walk = await createSiteVisit(app, project.id);
  const observation = await createObservation(app, walk.id, {
    observed: 'The duct is not supported at the transition.',
  });
  const raised = await createIssue(app, observation.id);

  const lines = await trail(app, project.id);
  const subjects = lines.map((line) => [line.action, line.subject]);

  expect(subjects).toEqual([
    ['project recorded', { type: 'project', id: project.id }],
    ['site visit recorded', { type: 'site-visit', id: walk.id }],
    ['observation recorded', { type: 'observation', id: observation.id }],
    ['issue raised', { type: 'issue', id: raised.id }],
  ]);

  // The whole document, searched: a subject that named a `sessions` row would
  // put a live credential into an append-only table that is read on a screen
  // and exported whole (issue #111).
  expect(JSON.stringify(lines)).not.toContain(app.sessionId);
});

/**
 * The run, once the worker has stopped writing — and **not** the audit line
 * the run wrote.
 *
 * The proposal's line is written *during* the run, and two writes follow it:
 * `underRunSession` revokes the run's session in a `finally`, and only then
 * does the worker stamp `finishedAt`. A test that returned on the line would
 * leave both racing its own `afterEach`, which force-closes the worker,
 * disconnects Prisma and drops the database `WITH (FORCE)` — and the abandoned
 * writes reconnecting into a database about to go are an unhandled error that
 * fails the whole run with every test in it passing. That cannot be reproduced
 * on a developer's machine, where the writes land before the teardown rather
 * than after; `.claude/rules/api.md` is where the rule lives, written after
 * issue #106's first CI run did exactly this.
 */
async function runFinished(app: TestApi, projectId: string, runId: string) {
  return until(async () => {
    const response = await app.fetch(`/v1/projects/${projectId}/memory/runs`);
    expect(response.status).toBe(200);
    const runs = (await response.json()) as { id: string; state: string }[];
    const found = runs.find((run) => run.id === runId);
    return found?.state === 'finished' ? found : undefined;
  }, `agent run ${runId} to finish`);
}

test('a line written during a run carries the person and the run, and the agent is never the actor', async () => {
  const app = await api({ worker: true });
  const project = await createProject(app, 'A-1', 'Riser replacement');

  // The harness's agent service calls `POST /v1/memory-runs/:id/proposal`
  // under the session the route minted for the run — which is what the real
  // adapter's tool does, over loopback, with no shared secret to present
  // (issue #105).
  const run = await requestMemoryRun(app, project.id);
  await runFinished(app, project.id, run.id);

  const written = (await trail(app, project.id)).find(
    (line) => line.action === 'proposal written',
  );
  expect(written).toBeDefined();

  // Both, with no special case: the session names the person who asked for
  // the run, and the run is on the row beside them (ADR-0055 part 6).
  expect(written?.actor).toEqual({ id: app.user.id, name: app.user.name });
  expect(written?.run).toEqual({ type: 'agent-run', id: run.id });

  // And the line the engineer wrote asking for it carries no run at all.
  const asked = (await trail(app, project.id)).find(
    (line) => line.action === 'memory run asked for',
  );
  expect(asked?.run).toBeNull();
  expect(asked?.subject).toEqual({ type: 'agent-run', id: run.id });
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

/**
 * The frame a line's prose is written in (issue #123, ADR-0054 decision 3 as
 * amended).
 *
 * This is ADR-0052's fourth point and not a formatting assertion: the injected
 * clock is nine hours from the typed side and shares nothing with it, so a
 * route that rendered the stamp it holds — or that rendered nothing and kept
 * the UTC face — reads a different sentence than the one asserted. The oracle
 * is the arithmetic written here: `2026-07-23T17:00:00.000Z` is 13:00 where
 * the building is, and nothing in the product computes the expected string.
 */
test("a line's prose reads the building's clock, not the frame it was stored in", async () => {
  const clock = fakeTimeSource(new Date('2026-07-24T02:00:00.000Z'));
  const app = await api({ timeSource: clock });
  const project = await createProject(app, 'A-1', 'Riser replacement');

  // Typed the morning after, for a walk that happened the afternoon before.
  await createSiteVisit(app, project.id, {
    startedAt: '2026-07-23T17:00:00.000Z',
  });

  const recorded = (await trail(app, project.id)).find(
    (line) => line.action === 'site visit recorded',
  );
  expect(recorded?.detail).toBe('started 2026-07-23 13:00');

  // And the line's own instant is still the stamp, a day later: the prose
  // carries a fact the column does not, which is why it keeps carrying one.
  expect(recorded?.createdAt).toBe('2026-07-24T02:00:00.000Z');
});

/**
 * The agreement issue #123 asks for, at the only place both halves exist.
 *
 * The feed renders `createdAt` in the project's zone beside `detail` verbatim
 * (`apps/web/app/projects/[id]/activity/page.tsx`), so a walk recorded as it
 * happens must read the same clock twice on one row. Before this the row said
 * `13:00` and `started 2026-07-23T17:00:00.000Z` — one event, two faces.
 */
test('a line and the column the feed renders beside it read one clock', async () => {
  const clock = fakeTimeSource(new Date('2026-07-23T17:00:00.000Z'));
  const app = await api({ timeSource: clock });
  const project = await createProject(app, 'A-1', 'Riser replacement');
  await createSiteVisit(app, project.id, {
    startedAt: '2026-07-23T17:00:00.000Z',
  });

  const recorded = (await trail(app, project.id)).find(
    (line) => line.action === 'site visit recorded',
  );
  // The instant the feed's column is rendered from...
  expect(recorded?.createdAt).toBe('2026-07-23T17:00:00.000Z');
  // ...and the face in the prose beside it, which is that instant in
  // `America/New_York` and is what the column reads too.
  expect(recorded?.detail).toBe('started 2026-07-23 13:00');
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
