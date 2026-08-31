import { afterEach, expect, test } from 'vitest';
import {
  type RegisterEntryResponse,
  type RegisterResponse,
  type TestApi,
  createOpenItem,
  createPhase,
  createProject,
  createRegisterEntry,
  createSubmission,
  fakeTimeSource,
  handoffBody,
  listRegisters,
  openItemBody,
  registerEntryBody,
  startTestApi,
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
    ...(body === undefined ? {} : { headers: json, body: JSON.stringify(body) }),
  });
}

const NO_SUCH = '2f1e6d8c-0000-4000-8000-000000000000';

async function entry(
  app: TestApi,
  id: string,
): Promise<RegisterEntryResponse> {
  const response = await app.fetch(`/v1/register-entries/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as RegisterEntryResponse;
}

async function register(
  app: TestApi,
  id: string,
): Promise<RegisterResponse> {
  const response = await app.fetch(`/v1/registers/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as RegisterResponse;
}

/** A job with both its registers, which is every job. */
async function job(app: TestApi, projectNumber = 'T-1', name = 'Wren Street') {
  const project = await createProject(app, projectNumber, name);
  const [submittals, rfis] = await listRegisters(app, project.id);
  if (submittals === undefined || rfis === undefined) {
    throw new Error('fixture failed: a project came back without both registers');
  }
  return { project, submittals, rfis };
}

// ── Two logs per job, and nobody makes them (story 70) ─────────────────────

test('a project is created with a submittals register and an RFIs register', async () => {
  const app = await api();
  const project = await createProject(app, 'T-1', 'Wren Street');

  const registers = await listRegisters(app, project.id);

  expect(registers.map((one) => one.kind)).toEqual(['SUBMITTAL', 'RFI']);
  for (const one of registers) {
    expect(one.projectId).toBe(project.id);
    expect(one.entries).toEqual([]);
  }
});

test('the two registers are one job\'s and not another\'s', async () => {
  const app = await api();
  const first = await job(app, 'T-1', 'Wren Street');
  const second = await job(app, 'T-2', 'Alcott Mill');

  const ids = new Set([
    first.submittals.id,
    first.rfis.id,
    second.submittals.id,
    second.rfis.id,
  ]);
  expect(ids.size).toBe(4);
  expect(second.submittals.projectId).toBe(second.project.id);
});

test('nothing creates or deletes a register', async () => {
  const app = await api();
  const { project, submittals } = await job(app);

  const created = await post(app, `/v1/projects/${project.id}/registers`, {
    kind: 'RFI',
  });
  expect(created.status).toBe(404);

  const deleted = await app.fetch(`/v1/registers/${submittals.id}`, {
    method: 'DELETE',
  });
  expect(deleted.status).toBe(404);
});

// ── An entry, and whose court it starts in (stories 70, 71) ────────────────

test('an entry is logged with its number, subject, parties and first handoff', async () => {
  const time = fakeTimeSource(new Date('2026-07-23T13:00:00.000Z'));
  const app = await api({ timeSource: time });
  const { project, submittals } = await job(app);

  const logged = await createRegisterEntry(app, submittals.id, {
    number: '23 05 93-1.1',
    subject: 'Rooftop unit shop drawings',
    fromParty: 'Acme Mechanical',
    toParty: 'Us',
    ballInCourt: handoffBody({ party: 'Us', inOurCourt: true }),
  });

  expect(logged.number).toBe('23 05 93-1.1');
  expect(logged.subject).toBe('Rooftop unit shop drawings');
  expect(logged.fromParty).toBe('Acme Mechanical');
  expect(logged.toParty).toBe('Us');
  expect(logged.kind).toBe('SUBMITTAL');
  expect(logged.projectId).toBe(project.id);
  expect(logged.registerId).toBe(submittals.id);
  expect(logged.question).toBeNull();
  expect(logged.response).toBeNull();
  expect(logged.submissionId).toBeNull();
  expect(logged.openItems).toEqual([]);

  // The first handoff is written in the same call, so there is no entry whose
  // current holder is nobody.
  expect(logged.handoffs).toHaveLength(1);
  expect(logged.ballInCourt).toEqual(logged.handoffs[0]);
  expect(logged.ballInCourt?.party).toBe('Us');
  expect(logged.ballInCourt?.inOurCourt).toBe(true);
  expect(logged.ballInCourt?.heldSince).toBe('2026-07-23T13:00:00.000Z');
});

test('a handoff may be dated, for a log written up after the fact', async () => {
  const time = fakeTimeSource(new Date('2026-07-23T13:00:00.000Z'));
  const app = await api({ timeSource: time });
  const { submittals } = await job(app);

  const logged = await createRegisterEntry(app, submittals.id, {
    ballInCourt: handoffBody({
      party: 'Us',
      inOurCourt: true,
      heldSince: '2026-06-01T09:30:00.000Z',
    }),
  });

  expect(logged.ballInCourt?.heldSince).toBe('2026-06-01T09:30:00.000Z');
});

test('the same number may be a submittal and an RFI, and never twice in one log', async () => {
  const app = await api();
  const { submittals, rfis } = await job(app);

  await createRegisterEntry(app, submittals.id, { number: '001' });
  await createRegisterEntry(app, rfis.id, {
    number: '001',
    question: 'What is the load at the north stair?',
  });

  const again = await post(
    app,
    `/v1/registers/${submittals.id}/entries`,
    registerEntryBody({ number: '001' }),
  );
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({
    message: 'that number is already in this register',
  });
  expect((await register(app, submittals.id)).entries).toHaveLength(1);
});

test('a register lists its entries in the order they were logged', async () => {
  const app = await api();
  const { submittals } = await job(app);

  await createRegisterEntry(app, submittals.id, { number: 'SUB-001' });
  await createRegisterEntry(app, submittals.id, { number: 'SUB-002' });

  expect((await register(app, submittals.id)).entries.map((e) => e.number)).toEqual([
    'SUB-001',
    'SUB-002',
  ]);
});

// ── The ball moves, and the record says how (stories 71, 80) ───────────────

test('the current holder is derived from a multi-handoff sequence', async () => {
  const time = fakeTimeSource(new Date('2026-07-01T09:00:00.000Z'));
  const app = await api({ timeSource: time });
  const { submittals } = await job(app);

  // Received for review: ours.
  const logged = await createRegisterEntry(app, submittals.id, {
    ballInCourt: handoffBody({ party: 'Us', inOurCourt: true }),
  });

  // Sent back for revision: theirs.
  time.advance(6 * 24 * 60 * 60 * 1000);
  const back = await post(app, `/v1/register-entries/${logged.id}/handoffs`, {
    party: 'Acme Mechanical',
    inOurCourt: false,
  });
  expect(back.status).toBe(201);
  expect(((await back.json()) as RegisterEntryResponse).ballInCourt?.party).toBe(
    'Acme Mechanical',
  );

  // Resubmitted: ours again, and genuinely a second interval.
  time.advance(10 * 24 * 60 * 60 * 1000);
  await post(app, `/v1/register-entries/${logged.id}/handoffs`, {
    party: 'Us',
    inOurCourt: true,
  });

  // Out to the architect for coordination.
  time.advance(2 * 24 * 60 * 60 * 1000);
  await post(app, `/v1/register-entries/${logged.id}/handoffs`, {
    party: 'The architect',
    inOurCourt: false,
  });

  const read = await entry(app, logged.id);

  expect(read.ballInCourt?.party).toBe('The architect');
  expect(read.ballInCourt?.inOurCourt).toBe(false);
  expect(read.handoffs.map((one) => [one.party, one.inOurCourt])).toEqual([
    ['Us', true],
    ['Acme Mechanical', false],
    ['Us', true],
    ['The architect', false],
  ]);
  expect(read.handoffs.map((one) => one.heldSince)).toEqual([
    '2026-07-01T09:00:00.000Z',
    '2026-07-07T09:00:00.000Z',
    '2026-07-17T09:00:00.000Z',
    '2026-07-19T09:00:00.000Z',
  ]);
});

test('the history is ordered by when the ball moved, not by when it was entered', async () => {
  const time = fakeTimeSource(new Date('2026-07-20T09:00:00.000Z'));
  const app = await api({ timeSource: time });
  const { submittals } = await job(app);

  const logged = await createRegisterEntry(app, submittals.id, {
    ballInCourt: handoffBody({
      party: 'Us',
      inOurCourt: true,
      heldSince: '2026-07-01T09:00:00.000Z',
    }),
  });

  // Entered last, but it happened in the middle: a transmittal log is written
  // up after the fact and out of order.
  await post(app, `/v1/register-entries/${logged.id}/handoffs`, {
    party: 'The architect',
    inOurCourt: false,
    heldSince: '2026-07-15T09:00:00.000Z',
  });
  await post(app, `/v1/register-entries/${logged.id}/handoffs`, {
    party: 'Acme Mechanical',
    inOurCourt: false,
    heldSince: '2026-07-08T09:00:00.000Z',
  });

  const read = await entry(app, logged.id);
  expect(read.handoffs.map((one) => one.party)).toEqual([
    'Us',
    'Acme Mechanical',
    'The architect',
  ]);
  expect(read.ballInCourt?.party).toBe('The architect');
});

test('handing the ball to whoever already holds it is two intervals, not a no-op', async () => {
  const time = fakeTimeSource(new Date('2026-07-01T09:00:00.000Z'));
  const app = await api({ timeSource: time });
  const { submittals } = await job(app);

  const logged = await createRegisterEntry(app, submittals.id, {
    ballInCourt: handoffBody({ party: 'Us', inOurCourt: true }),
  });

  time.advance(24 * 60 * 60 * 1000);
  const again = await post(
    app,
    `/v1/register-entries/${logged.id}/handoffs`,
    { party: 'Us', inOurCourt: true },
  );

  expect(again.status).toBe(201);
  expect((await entry(app, logged.id)).handoffs).toHaveLength(2);
});

test('a party is not what says the ball is ours', async () => {
  const app = await api();
  const { submittals } = await job(app);

  // A job that calls us by the firm's name still accrues, and a third party
  // named "us" does not.
  const logged = await createRegisterEntry(app, submittals.id, {
    ballInCourt: handoffBody({ party: 'Alcott Engineering', inOurCourt: true }),
  });
  expect(logged.ballInCourt?.inOurCourt).toBe(true);

  await post(app, `/v1/register-entries/${logged.id}/handoffs`, {
    party: 'us',
    inOurCourt: false,
  });
  expect((await entry(app, logged.id)).ballInCourt?.inOurCourt).toBe(false);
});

test('nothing rewrites a handoff', async () => {
  const app = await api();
  const { submittals } = await job(app);
  const logged = await createRegisterEntry(app, submittals.id);
  const first = logged.handoffs[0];

  for (const method of ['PATCH', 'PUT', 'DELETE']) {
    const carries = method !== 'DELETE';
    const response = await app.fetch(
      `/v1/ball-in-court-events/${first?.id}`,
      {
        method,
        ...(carries ? { headers: json, body: JSON.stringify({ party: 'X' }) } : {}),
      },
    );
    expect(response.status, method).toBe(404);
  }

  expect((await entry(app, logged.id)).handoffs[0]).toEqual(first);
});

// ── An RFI's question, and later its answer (story 78) ─────────────────────

test('an RFI carries a question and, later, a response', async () => {
  const app = await api();
  const { rfis } = await job(app);

  const asked = await createRegisterEntry(app, rfis.id, {
    number: 'RFI-012',
    question: 'What is the load at the north stair?',
  });
  expect(asked.kind).toBe('RFI');
  expect(asked.question).toBe('What is the load at the north stair?');
  expect(asked.response).toBeNull();

  const answered = await post(
    app,
    `/v1/register-entries/${asked.id}/response`,
    { response: '4.2 kN, per the structural drawings issued 2026-06-30.' },
  );
  expect(answered.status).toBe(200);

  const read = await entry(app, asked.id);
  expect(read.question).toBe('What is the load at the north stair?');
  expect(read.response).toBe(
    '4.2 kN, per the structural drawings issued 2026-06-30.',
  );
});

test('an RFI without a question is refused, and nothing is logged', async () => {
  const app = await api();
  const { rfis } = await job(app);

  const response = await post(
    app,
    `/v1/registers/${rfis.id}/entries`,
    registerEntryBody({ number: 'RFI-012' }),
  );

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ message: 'an RFI needs a question' });
  expect((await register(app, rfis.id)).entries).toEqual([]);
});

test('a submittal has no question and no response', async () => {
  const app = await api();
  const { submittals } = await job(app);

  const asked = await post(
    app,
    `/v1/registers/${submittals.id}/entries`,
    registerEntryBody({ question: 'Why?' }),
  );
  expect(asked.status).toBe(409);
  expect(await asked.json()).toEqual({ message: 'a submittal has no question' });
  expect((await register(app, submittals.id)).entries).toEqual([]);

  const logged = await createRegisterEntry(app, submittals.id);
  const answered = await post(
    app,
    `/v1/register-entries/${logged.id}/response`,
    { response: 'Approved as noted.' },
  );
  expect(answered.status).toBe(409);
  expect(await answered.json()).toEqual({
    message: 'only an RFI has a response',
  });
});

test('a second response is refused rather than overwriting the first', async () => {
  const app = await api();
  const { rfis } = await job(app);
  const asked = await createRegisterEntry(app, rfis.id, {
    question: 'What is the load at the north stair?',
  });

  await post(app, `/v1/register-entries/${asked.id}/response`, {
    response: '4.2 kN.',
  });
  const again = await post(app, `/v1/register-entries/${asked.id}/response`, {
    response: 'Actually 5 kN.',
  });

  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({
    message: 'that entry already has a response',
  });
  expect((await entry(app, asked.id)).response).toBe('4.2 kN.');
});

// ── The issuance that answered it (stories 81, 35) ─────────────────────────

test('an entry links to the submission that responded to it', async () => {
  const app = await api();
  const { project, submittals } = await job(app);
  const phase = await createPhase(app, project.id, '90% CD');
  const issued = await createSubmission(app, project.id, { phaseId: phase.id });

  const logged = await createRegisterEntry(app, submittals.id);
  const linked = await post(
    app,
    `/v1/register-entries/${logged.id}/submission`,
    { submissionId: issued.id },
  );

  expect(linked.status).toBe(200);
  expect((await entry(app, logged.id)).submissionId).toBe(issued.id);
});

test('linking writes nothing to the submission, which nothing updates', async () => {
  const app = await api();
  const { project, submittals } = await job(app);
  const phase = await createPhase(app, project.id, '90% CD');
  const issued = await createSubmission(app, project.id, { phaseId: phase.id });
  const logged = await createRegisterEntry(app, submittals.id);

  const before = await (await app.fetch(`/v1/submissions/${issued.id}`)).json();
  await post(app, `/v1/register-entries/${logged.id}/submission`, {
    submissionId: issued.id,
  });
  const after = await (await app.fetch(`/v1/submissions/${issued.id}`)).json();

  expect(after).toEqual(before);
});

test('a submission on another job cannot be what answered this entry', async () => {
  const app = await api();
  const { submittals } = await job(app, 'T-1', 'Wren Street');
  const other = await createProject(app, 'T-2', 'Alcott Mill');
  const phase = await createPhase(app, other.id, '90% CD');
  const elsewhere = await createSubmission(app, other.id, { phaseId: phase.id });

  const logged = await createRegisterEntry(app, submittals.id);
  const linked = await post(
    app,
    `/v1/register-entries/${logged.id}/submission`,
    { submissionId: elsewhere.id },
  );

  expect(linked.status).toBe(409);
  expect(await linked.json()).toEqual({
    message: 'that submission belongs to another project',
  });
  expect((await entry(app, logged.id)).submissionId).toBeNull();
});

test('a second link is refused rather than repointing the first', async () => {
  const app = await api();
  const { project, submittals } = await job(app);
  const phase = await createPhase(app, project.id, '90% CD');
  const first = await createSubmission(app, project.id, { phaseId: phase.id });
  const second = await createSubmission(app, project.id, {
    phaseId: phase.id,
    revision: 'Rev 2',
  });

  const logged = await createRegisterEntry(app, submittals.id);
  await post(app, `/v1/register-entries/${logged.id}/submission`, {
    submissionId: first.id,
  });
  const again = await post(
    app,
    `/v1/register-entries/${logged.id}/submission`,
    { submissionId: second.id },
  );

  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({
    message: 'that entry is already linked to a submission',
  });
  expect((await entry(app, logged.id)).submissionId).toBe(first.id);
});

// ── An open item chased for an entry (story 79) ────────────────────────────

test('an open item raised on an entry reaches the pending items view with its job', async () => {
  const app = await api();
  const { project, submittals } = await job(app);
  const logged = await createRegisterEntry(app, submittals.id);

  const raised = await post(
    app,
    `/v1/register-entries/${logged.id}/open-items`,
    openItemBody({
      unresolved: 'The load data for the north stair',
      blocks: 'Reviewing this submittal',
      waitingOn: 'Acme Mechanical',
    }),
  );
  expect(raised.status).toBe(201);

  // The subject says where it lives, and it lives on the job (ADR-0031).
  const item = (await raised.json()) as { id: string; subjectId: string };
  expect(item.subjectId).toBe(project.id);

  const pending = (await (
    await app.fetch('/v1/open-items')
  ).json()) as { id: string; project: { id: string } | null }[];
  const found = pending.find((one) => one.id === item.id);
  expect(found?.project?.id).toBe(project.id);

  expect((await entry(app, logged.id)).openItems.map((one) => one.id)).toEqual([
    item.id,
  ]);
});

test('an item already on the job can be chased for an entry too', async () => {
  const app = await api();
  const { project, submittals } = await job(app);
  const logged = await createRegisterEntry(app, submittals.id);
  const item = await createOpenItem(app, project.id);

  const attached = await post(
    app,
    `/v1/register-entries/${logged.id}/open-items/${item.id}`,
  );
  expect(attached.status).toBe(204);
  expect((await entry(app, logged.id)).openItems.map((one) => one.id)).toEqual([
    item.id,
  ]);

  const again = await post(
    app,
    `/v1/register-entries/${logged.id}/open-items/${item.id}`,
  );
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({
    message: 'that open item is already on this entry',
  });
});

test('an open item on another job cannot be chased for this entry', async () => {
  const app = await api();
  const { submittals } = await job(app, 'T-1', 'Wren Street');
  const other = await createProject(app, 'T-2', 'Alcott Mill');
  const elsewhere = await createOpenItem(app, other.id);
  const logged = await createRegisterEntry(app, submittals.id);

  const attached = await post(
    app,
    `/v1/register-entries/${logged.id}/open-items/${elsewhere.id}`,
  );
  expect(attached.status).toBe(409);
  expect(await attached.json()).toEqual({
    message: 'that open item is on another project',
  });
});

// ── What an entry is, and what nothing may do to it ────────────────────────

test('an entry comes back with exactly these fields', async () => {
  const app = await api();
  const { rfis } = await job(app);
  const logged = await createRegisterEntry(app, rfis.id, {
    question: 'What is the load at the north stair?',
  });

  // A status column, a ball-in-court column or a clock would have to appear
  // here, so one cannot be added without this test saying so. Whose move it
  // is now is `ballInCourt`, derived from `handoffs` and stored nowhere.
  expect(Object.keys(logged).sort()).toEqual([
    'ballInCourt',
    'createdAt',
    'fromParty',
    'handoffs',
    'id',
    'kind',
    'number',
    'openItems',
    'projectId',
    'question',
    'registerId',
    'response',
    'subject',
    'submissionId',
    'toParty',
  ]);
});

test('a handoff comes back with exactly these fields', async () => {
  const app = await api();
  const { submittals } = await job(app);
  const logged = await createRegisterEntry(app, submittals.id);

  expect(Object.keys(logged.handoffs[0] ?? {}).sort()).toEqual([
    'createdAt',
    'heldSince',
    'id',
    'inOurCourt',
    'party',
    'registerEntryId',
  ]);
});

test.each(['PATCH', 'PUT', 'DELETE'])(
  'nothing edits a register entry: %s is refused',
  async (method) => {
    const app = await api();
    const { submittals } = await job(app);
    const logged = await createRegisterEntry(app, submittals.id);

    // A DELETE carries no body, and so no content-type either: sending one
    // would be refused for the empty body and never reach the router.
    const carries = method !== 'DELETE';
    const response = await app.fetch(`/v1/register-entries/${logged.id}`, {
      method,
      ...(carries
        ? { headers: json, body: JSON.stringify({ subject: 'Something else' }) }
        : {}),
    });

    expect(response.status, method).toBe(404);
    expect((await entry(app, logged.id)).subject).toBe(
      'Rooftop unit shop drawings',
    );
  },
);

test.each([
  ['no number', { number: undefined }],
  ['an empty number', { number: '' }],
  ['a number of only whitespace', { number: '   ' }],
  ['an over-long number', { number: 'x'.repeat(33) }],
  ['no subject', { subject: undefined }],
  ['an empty subject', { subject: '' }],
  ['an over-long subject', { subject: 'x'.repeat(201) }],
  ['nobody it came from', { fromParty: undefined }],
  ['a from-party of only whitespace', { fromParty: '   ' }],
  ['nobody it is directed to', { toParty: undefined }],
  ['an over-long party', { toParty: 'x'.repeat(121) }],
  ['no ball-in-court at all', { ballInCourt: undefined }],
])('an entry with %s is rejected and nothing is logged', async (_why, patch) => {
  const app = await api();
  const { submittals } = await job(app);

  const response = await post(
    app,
    `/v1/registers/${submittals.id}/entries`,
    registerEntryBody(patch),
  );

  expect(response.status).toBe(400);
  expect((await register(app, submittals.id)).entries).toEqual([]);
});

test.each([
  ['no party', { party: undefined }],
  ['a party of only whitespace', { party: '   ' }],
  ['no word on whose court it is', { inOurCourt: undefined }],
  ['a court that is not a boolean', { inOurCourt: 'yes' }],
  ['an unparseable held-since', { heldSince: 'last March' }],
])(
  'a first handoff with %s is rejected and nothing is logged',
  async (_why, patch) => {
    const app = await api();
    const { submittals } = await job(app);

    const response = await post(
      app,
      `/v1/registers/${submittals.id}/entries`,
      registerEntryBody({
        ballInCourt: handoffBody(patch),
      }),
    );

    expect(response.status).toBe(400);
    expect((await register(app, submittals.id)).entries).toEqual([]);
  },
);

test('an entry cannot carry a field the record does not have', async () => {
  const app = await api();
  const { submittals } = await job(app);

  const response = await post(app, `/v1/registers/${submittals.id}/entries`, {
    ...registerEntryBody(),
    disposition: 'Approved',
  });

  expect(response.status).toBe(400);
  expect((await register(app, submittals.id)).entries).toEqual([]);
});

test('an unknown project, register or entry is a 404 everywhere it is named', async () => {
  const app = await api();
  const { submittals } = await job(app);
  const logged = await createRegisterEntry(app, submittals.id);

  const misses = [
    await app.fetch(`/v1/projects/${NO_SUCH}/registers`),
    await app.fetch(`/v1/registers/${NO_SUCH}`),
    await app.fetch(`/v1/register-entries/${NO_SUCH}`),
    await post(app, `/v1/registers/${NO_SUCH}/entries`, registerEntryBody()),
    await post(app, `/v1/register-entries/${NO_SUCH}/handoffs`, {
      party: 'Us',
      inOurCourt: true,
    }),
    await post(app, `/v1/register-entries/${NO_SUCH}/response`, {
      response: 'Anything',
    }),
    await post(app, `/v1/register-entries/${NO_SUCH}/submission`, {
      submissionId: NO_SUCH,
    }),
    await post(
      app,
      `/v1/register-entries/${NO_SUCH}/open-items`,
      openItemBody(),
    ),
    await post(
      app,
      `/v1/register-entries/${NO_SUCH}/open-items/${NO_SUCH}`,
    ),
  ];
  for (const response of misses) {
    expect(response.status).toBe(404);
  }

  // And a submission that does not exist, named on an entry that does.
  const linked = await post(
    app,
    `/v1/register-entries/${logged.id}/submission`,
    { submissionId: NO_SUCH },
  );
  expect(linked.status).toBe(404);
  expect(await linked.json()).toEqual({ message: 'no submission with that id' });
});
