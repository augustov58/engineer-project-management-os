import { afterEach, expect, test } from 'vitest';
import {
  type ClockRow,
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

  // A status column or a ball-in-court column would have to appear here, so
  // one cannot be added without this test saying so — and issue #15 is the
  // slice that would have been tempted to. Whose move it is now is
  // `ballInCourt`, how long it has been ours is `inCourtMs`, and whether that
  // is too long is `pastClock`: all three derived from `handoffs` and stored
  // nowhere. `disposition` and `disposedAt` are stored and are an outcome,
  // not a state; there is still no `clockStarted` and no `clockStopped`.
  expect(Object.keys(logged).sort()).toEqual([
    'ballInCourt',
    'createdAt',
    'disposedAt',
    'disposition',
    'fromParty',
    'handoffs',
    'id',
    'inCourtMs',
    'kind',
    'nextRoundId',
    'number',
    'openItems',
    'pastClock',
    'previousRoundId',
    'projectId',
    'question',
    'registerId',
    'response',
    'subject',
    'submissionId',
    'toParty',
    'turnaroundDays',
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
    // The PRD sketch names this column and the record does not have it: the
    // clock's start is the handoff history, not a value a caller supplies.
    clockStarted: '2026-07-01T09:00:00.000Z',
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
    await post(app, `/v1/register-entries/${NO_SUCH}/turnaround`, {
      turnaroundDays: 14,
    }),
    await post(app, `/v1/register-entries/${NO_SUCH}/disposition`, {
      disposition: 'Approved',
      ballInCourt: { party: 'Acme Mechanical', inOurCourt: false },
    }),
    await post(
      app,
      `/v1/register-entries/${NO_SUCH}/next-round`,
      registerEntryBody({ number: 'SUB-002' }),
    ),
    await app.fetch(`/v1/clock?projectId=${NO_SUCH}`),
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

// ── The clock: how long it has been ours (issue #15) ───────────────────────

/** Milliseconds, written the way the handoff tests above already write them. */
function days(count: number): number {
  return count * 24 * 60 * 60 * 1000;
}

/** The five, byte-exact and in the order every source writes them. */
const DISPOSITIONS = [
  'Approved',
  'Approved as Noted',
  'Revise and Resubmit',
  'Rejected',
  'For Record Only',
];

/** A handoff that puts the ball in our court, which is what the clock reads. */
function ours() {
  return handoffBody({ party: 'Us', inOurCourt: true });
}

async function clock(app: TestApi, projectId?: string): Promise<ClockRow[]> {
  const path =
    projectId === undefined ? '/v1/clock' : `/v1/clock?projectId=${projectId}`;
  const response = await app.fetch(path);
  expect(response.status).toBe(200);
  return (await response.json()) as ClockRow[];
}

// ── A turnaround target, so "past its clock" is not a guess (story 73) ─────

test('a turnaround target is set on an entry', async () => {
  const app = await api();
  const { submittals } = await job(app);
  const logged = await createRegisterEntry(app, submittals.id);
  expect(logged.turnaroundDays).toBeNull();

  const set = await post(app, `/v1/register-entries/${logged.id}/turnaround`, {
    turnaroundDays: 14,
  });

  expect(set.status).toBe(200);
  expect((await entry(app, logged.id)).turnaroundDays).toBe(14);
});

test('a turnaround target may be named in the call that logs the entry', async () => {
  const app = await api();
  const { submittals } = await job(app);

  const logged = await createRegisterEntry(app, submittals.id, {
    turnaroundDays: 21,
  });

  expect(logged.turnaroundDays).toBe(21);
});

test('a second turnaround target is refused rather than replacing the first', async () => {
  const app = await api();
  const { submittals } = await job(app);
  const logged = await createRegisterEntry(app, submittals.id, {
    turnaroundDays: 14,
  });

  const again = await post(
    app,
    `/v1/register-entries/${logged.id}/turnaround`,
    { turnaroundDays: 30 },
  );

  expect(again.status).toBe(409);
  // Moving a target moves which entries were past their clock, backwards
  // through every day the number was different.
  expect((await entry(app, logged.id)).turnaroundDays).toBe(14);
});

test.each([
  ['zero days', 0],
  ['a negative number', -1],
  ['a fraction of a day', 1.5],
  ['more than a year', 366],
  ['a word rather than a number', 'a fortnight'],
])('a turnaround target of %s is refused', async (_why, turnaroundDays) => {
  const app = await api();
  const { submittals } = await job(app);
  const logged = await createRegisterEntry(app, submittals.id);

  const set = await post(app, `/v1/register-entries/${logged.id}/turnaround`, {
    turnaroundDays,
  });

  expect(set.status).toBe(400);
  expect((await entry(app, logged.id)).turnaroundDays).toBeNull();
});

// ── Accrual runs only while the ball is ours (story 72) ───────────────────

test('elapsed in-court time excludes the intervals the ball was elsewhere', async () => {
  const time = fakeTimeSource(new Date('2026-07-01T09:00:00.000Z'));
  const app = await api({ timeSource: time });
  const { submittals } = await job(app);

  // Received for review: ours.
  const logged = await createRegisterEntry(app, submittals.id, {
    ballInCourt: ours(),
  });

  // Six days on our desk, then back to the contractor for revision.
  time.advance(days(6));
  await post(app, `/v1/register-entries/${logged.id}/handoffs`, {
    party: 'Acme Mechanical',
    inOurCourt: false,
  });

  // Ten days with them, then resubmitted: genuinely a second interval.
  time.advance(days(10));
  await post(app, `/v1/register-entries/${logged.id}/handoffs`, {
    party: 'Us',
    inOurCourt: true,
  });

  // Two more days, then out to the architect for coordination.
  time.advance(days(2));
  await post(app, `/v1/register-entries/${logged.id}/handoffs`, {
    party: 'The architect',
    inOurCourt: false,
  });

  // Six plus two. The ten days the contractor had it are not counted
  // against us, which is the whole of what the clock is for.
  expect((await entry(app, logged.id)).inCourtMs).toBe(days(8));

  // And a fortnight with the architect adds nothing.
  time.advance(days(14));
  expect((await entry(app, logged.id)).inCourtMs).toBe(days(8));
});

test('the open interval accrues while the ball is still ours', async () => {
  const time = fakeTimeSource(new Date('2026-07-01T09:00:00.000Z'));
  const app = await api({ timeSource: time });
  const { submittals } = await job(app);
  const logged = await createRegisterEntry(app, submittals.id, {
    ballInCourt: ours(),
  });

  expect(logged.inCourtMs).toBe(0);

  time.advance(days(3));
  expect((await entry(app, logged.id)).inCourtMs).toBe(days(3));

  time.advance(days(4));
  expect((await entry(app, logged.id)).inCourtMs).toBe(days(7));
});

test('an entry that has never been in our court accrues nothing', async () => {
  const time = fakeTimeSource(new Date('2026-07-01T09:00:00.000Z'));
  const app = await api({ timeSource: time });
  const { rfis } = await job(app);

  // An RFI we raised: it sits with the architect from the moment it is logged.
  const logged = await createRegisterEntry(app, rfis.id, {
    number: 'RFI-004',
    question: 'What is the load at the north stair?',
    turnaroundDays: 7,
    ballInCourt: handoffBody({ party: 'The architect', inOurCourt: false }),
  });

  time.advance(days(30));

  const read = await entry(app, logged.id);
  expect(read.inCourtMs).toBe(0);
  expect(read.pastClock).toBe(false);
});

test('a party is not what says the ball is ours, and the clock reads the boolean', async () => {
  const time = fakeTimeSource(new Date('2026-07-01T09:00:00.000Z'));
  const app = await api({ timeSource: time });
  const { submittals } = await job(app);

  // A job that calls us by the firm's name still accrues.
  const named = await createRegisterEntry(app, submittals.id, {
    number: 'SUB-001',
    ballInCourt: handoffBody({ party: 'Fenwick Engineering', inOurCourt: true }),
  });
  // And a third party who happens to be called "us" does not.
  const notOurs = await createRegisterEntry(app, submittals.id, {
    number: 'SUB-002',
    ballInCourt: handoffBody({ party: 'Us Holdings Ltd', inOurCourt: false }),
  });

  time.advance(days(5));

  expect((await entry(app, named.id)).inCourtMs).toBe(days(5));
  expect((await entry(app, notOurs.id)).inCourtMs).toBe(0);
});

// ── Past its clock (stories 43, 74) ───────────────────────────────────────

test('an entry is past its clock only once elapsed in-court time exceeds the target', async () => {
  const time = fakeTimeSource(new Date('2026-07-01T09:00:00.000Z'));
  const app = await api({ timeSource: time });
  const { submittals } = await job(app);
  const logged = await createRegisterEntry(app, submittals.id, {
    turnaroundDays: 14,
    ballInCourt: ours(),
  });

  time.advance(days(14));
  // Exactly the target is not past it.
  expect((await entry(app, logged.id)).pastClock).toBe(false);

  time.advance(1);
  expect((await entry(app, logged.id)).pastClock).toBe(true);
});

test('an entry with no turnaround target is never past its clock', async () => {
  const time = fakeTimeSource(new Date('2026-07-01T09:00:00.000Z'));
  const app = await api({ timeSource: time });
  const { submittals } = await job(app);
  const logged = await createRegisterEntry(app, submittals.id, {
    ballInCourt: ours(),
  });

  time.advance(days(400));

  const read = await entry(app, logged.id);
  expect(read.inCourtMs).toBe(days(400));
  // Past what? There is nothing to be past, and guessing is what story 73
  // exists to remove.
  expect(read.pastClock).toBe(false);
  expect(await clock(app)).toEqual([]);
});

test('handing the ball on takes an entry off the clock and leaves what it took us standing', async () => {
  const time = fakeTimeSource(new Date('2026-07-01T09:00:00.000Z'));
  const app = await api({ timeSource: time });
  const { submittals } = await job(app);
  const logged = await createRegisterEntry(app, submittals.id, {
    turnaroundDays: 14,
    ballInCourt: ours(),
  });

  time.advance(days(40));
  expect((await entry(app, logged.id)).pastClock).toBe(true);

  await post(app, `/v1/register-entries/${logged.id}/handoffs`, {
    party: 'Acme Mechanical',
    inOurCourt: false,
  });

  const read = await entry(app, logged.id);
  // Not sitting in our court, so not on the daily list — and the forty days
  // it took us are still on the record.
  expect(read.pastClock).toBe(false);
  expect(read.inCourtMs).toBe(days(40));
});

// ── A disposition stops the clock and hands the ball back (stories 75, 76) ─

test('recording a disposition stops the clock and hands the ball back in one action', async () => {
  const time = fakeTimeSource(new Date('2026-07-01T09:00:00.000Z'));
  const app = await api({ timeSource: time });
  const { submittals } = await job(app);
  const logged = await createRegisterEntry(app, submittals.id, {
    turnaroundDays: 14,
    ballInCourt: ours(),
  });

  time.advance(days(20));
  expect((await entry(app, logged.id)).pastClock).toBe(true);

  const reviewed = await post(
    app,
    `/v1/register-entries/${logged.id}/disposition`,
    {
      disposition: 'Approved as Noted',
      ballInCourt: { party: 'Acme Mechanical', inOurCourt: false },
    },
  );
  expect(reviewed.status).toBe(200);

  const read = await entry(app, logged.id);
  expect(read.disposition).toBe('Approved as Noted');
  expect(read.disposedAt).toBe('2026-07-21T09:00:00.000Z');
  expect(read.ballInCourt?.party).toBe('Acme Mechanical');
  expect(read.ballInCourt?.inOurCourt).toBe(false);
  expect(read.pastClock).toBe(false);

  // Stopped by the ball being elsewhere and not by a column, so it stays
  // stopped without anything having to keep saying so.
  time.advance(days(60));
  const later = await entry(app, logged.id);
  expect(later.inCourtMs).toBe(days(20));
  expect(later.pastClock).toBe(false);
});

test.each(DISPOSITIONS)('%s is one of the five a review may reach', async (disposition) => {
  const app = await api();
  const { submittals } = await job(app);
  const logged = await createRegisterEntry(app, submittals.id, {
    ballInCourt: ours(),
  });

  const reviewed = await post(
    app,
    `/v1/register-entries/${logged.id}/disposition`,
    {
      disposition,
      ballInCourt: { party: 'Acme Mechanical', inOurCourt: false },
    },
  );

  expect(reviewed.status).toBe(200);
  expect((await entry(app, logged.id)).disposition).toBe(disposition);
});

test.each([
  ['a sixth value nobody agreed', 'Approved with Comments'],
  ['the right words in the wrong case', 'approved'],
  ['an ampersand for the word', 'Revise & Resubmit'],
  ['nothing at all', ''],
])(
  'a disposition of %s is refused and no handoff is written',
  async (_why, disposition) => {
    const app = await api();
    const { submittals } = await job(app);
    const logged = await createRegisterEntry(app, submittals.id, {
      ballInCourt: ours(),
    });

    const reviewed = await post(
      app,
      `/v1/register-entries/${logged.id}/disposition`,
      {
        disposition,
        ballInCourt: { party: 'Acme Mechanical', inOurCourt: false },
      },
    );

    expect(reviewed.status).toBe(400);
    const read = await entry(app, logged.id);
    expect(read.disposition).toBeNull();
    expect(read.disposedAt).toBeNull();
    // The ball did not move either: the two are one action.
    expect(read.handoffs).toHaveLength(1);
  },
);

test('only a submittal has a disposition', async () => {
  const app = await api();
  const { rfis } = await job(app);
  const logged = await createRegisterEntry(app, rfis.id, {
    number: 'RFI-004',
    question: 'What is the load at the north stair?',
    ballInCourt: ours(),
  });

  const reviewed = await post(
    app,
    `/v1/register-entries/${logged.id}/disposition`,
    {
      disposition: 'Approved',
      ballInCourt: { party: 'The architect', inOurCourt: false },
    },
  );

  expect(reviewed.status).toBe(409);
  const read = await entry(app, logged.id);
  expect(read.disposition).toBeNull();
  expect(read.handoffs).toHaveLength(1);
});

test('a second disposition is refused rather than overwriting the first', async () => {
  const app = await api();
  const { submittals } = await job(app);
  const logged = await createRegisterEntry(app, submittals.id, {
    ballInCourt: ours(),
  });

  const back = { party: 'Acme Mechanical', inOurCourt: false };
  await post(app, `/v1/register-entries/${logged.id}/disposition`, {
    disposition: 'Revise and Resubmit',
    ballInCourt: back,
  });

  const again = await post(
    app,
    `/v1/register-entries/${logged.id}/disposition`,
    { disposition: 'Approved', ballInCourt: back },
  );

  expect(again.status).toBe(409);
  const read = await entry(app, logged.id);
  expect(read.disposition).toBe('Revise and Resubmit');
  // And no second handoff went in behind the refusal.
  expect(read.handoffs).toHaveLength(2);
});

test('a disposition entered from a transmittal log is dated when the review happened', async () => {
  const time = fakeTimeSource(new Date('2026-07-01T09:00:00.000Z'));
  const app = await api({ timeSource: time });
  const { submittals } = await job(app);
  const logged = await createRegisterEntry(app, submittals.id, {
    ballInCourt: ours(),
  });

  // Typed up on the 25th; the review went back on the 10th.
  time.advance(days(24));
  await post(app, `/v1/register-entries/${logged.id}/disposition`, {
    disposition: 'Approved',
    ballInCourt: {
      party: 'Acme Mechanical',
      inOurCourt: false,
      heldSince: '2026-07-10T09:00:00.000Z',
    },
  });

  const read = await entry(app, logged.id);
  expect(read.disposedAt).toBe('2026-07-10T09:00:00.000Z');
  expect(read.ballInCourt?.heldSince).toBe('2026-07-10T09:00:00.000Z');
  // And the clock stopped on the 10th, not on the 25th.
  expect(read.inCourtMs).toBe(days(9));
});

// ── The round that came back (story 77) ──────────────────────────────────

test('a next round is logged in the same register and linked to the round it follows', async () => {
  const app = await api();
  const { submittals } = await job(app);
  const first = await createRegisterEntry(app, submittals.id, {
    number: 'SUB-001',
    turnaroundDays: 14,
    ballInCourt: ours(),
  });
  await post(app, `/v1/register-entries/${first.id}/disposition`, {
    disposition: 'Revise and Resubmit',
    ballInCourt: { party: 'Acme Mechanical', inOurCourt: false },
  });

  const created = await post(
    app,
    `/v1/register-entries/${first.id}/next-round`,
    registerEntryBody({
      number: 'SUB-001.1',
      turnaroundDays: 14,
      ballInCourt: ours(),
    }),
  );

  expect(created.status).toBe(201);
  const next = (await created.json()) as RegisterEntryResponse;
  expect(next.previousRoundId).toBe(first.id);
  expect(next.nextRoundId).toBeNull();
  expect(next.registerId).toBe(submittals.id);
  expect(next.turnaroundDays).toBe(14);
  // The chain reads from both ends, off the one column.
  const read = await entry(app, first.id);
  expect(read.nextRoundId).toBe(next.id);
  // And nothing was written to the round it follows.
  expect(read.disposition).toBe('Revise and Resubmit');
  expect(read.previousRoundId).toBeNull();
  expect((await register(app, submittals.id)).entries.map((one) => one.number)).toEqual([
    'SUB-001',
    'SUB-001.1',
  ]);
});

test('the next round starts its own clock', async () => {
  const time = fakeTimeSource(new Date('2026-07-01T09:00:00.000Z'));
  const app = await api({ timeSource: time });
  const { submittals } = await job(app);
  const first = await createRegisterEntry(app, submittals.id, {
    number: 'SUB-001',
    turnaroundDays: 14,
    ballInCourt: ours(),
  });

  time.advance(days(20));
  const created = await post(
    app,
    `/v1/register-entries/${first.id}/next-round`,
    registerEntryBody({
      number: 'SUB-001.1',
      turnaroundDays: 14,
      ballInCourt: ours(),
    }),
  );
  const next = (await created.json()) as RegisterEntryResponse;

  expect(next.inCourtMs).toBe(0);
  expect(next.pastClock).toBe(false);
  // The round it follows kept its own twenty days.
  expect((await entry(app, first.id)).inCourtMs).toBe(days(20));
});

test('a second next round is refused rather than repointing the first', async () => {
  const app = await api();
  const { submittals } = await job(app);
  const first = await createRegisterEntry(app, submittals.id, {
    number: 'SUB-001',
    ballInCourt: ours(),
  });
  await post(
    app,
    `/v1/register-entries/${first.id}/next-round`,
    registerEntryBody({ number: 'SUB-001.1', ballInCourt: ours() }),
  );

  const again = await post(
    app,
    `/v1/register-entries/${first.id}/next-round`,
    registerEntryBody({ number: 'SUB-001.2', ballInCourt: ours() }),
  );

  expect(again.status).toBe(409);
  expect((await register(app, submittals.id)).entries.map((one) => one.number)).toEqual([
    'SUB-001',
    'SUB-001.1',
  ]);
});

test('only a submittal has another round', async () => {
  const app = await api();
  const { rfis } = await job(app);
  const logged = await createRegisterEntry(app, rfis.id, {
    number: 'RFI-004',
    question: 'What is the load at the north stair?',
    ballInCourt: ours(),
  });

  const created = await post(
    app,
    `/v1/register-entries/${logged.id}/next-round`,
    registerEntryBody({
      number: 'RFI-004.1',
      question: 'And at the south?',
      ballInCourt: ours(),
    }),
  );

  expect(created.status).toBe(409);
  expect((await register(app, rfis.id)).entries).toHaveLength(1);
});

// ── The clock, cross-project and per-project (stories 43-46, 74) ──────────

test('the clock lists every entry past its clock across every project, longest first', async () => {
  const time = fakeTimeSource(new Date('2026-07-01T09:00:00.000Z'));
  const app = await api({ timeSource: time });
  const first = await job(app, 'T-1', 'Wren Street');
  const second = await job(app, 'T-2', 'Alcott Mill');

  // Logged first, and the one that ends up furthest past its target: twenty
  // days against three. It is not the one that has been ours longest.
  await createRegisterEntry(app, first.submittals.id, {
    number: 'SUB-001',
    turnaroundDays: 3,
    ballInCourt: ours(),
  });
  // Never ours, however short its target.
  await createRegisterEntry(app, first.submittals.id, {
    number: 'SUB-002',
    turnaroundDays: 1,
    ballInCourt: handoffBody({ party: 'Acme Mechanical', inOurCourt: false }),
  });
  // Ours from the start, against a target it will not reach in this test.
  await createRegisterEntry(app, first.submittals.id, {
    number: 'SUB-003',
    turnaroundDays: 90,
    ballInCourt: ours(),
  });

  time.advance(days(10));

  // Logged last, on the other job, and in our court since ten days before the
  // first one was logged — thirty days against twenty-five. Longest in our
  // court and *least* past its target, which is what separates the two
  // readings of "oldest first" this fixture exists to separate.
  await createRegisterEntry(app, second.submittals.id, {
    number: 'SUB-009',
    turnaroundDays: 25,
    ballInCourt: handoffBody({
      party: 'Us',
      inOurCourt: true,
      heldSince: '2026-06-21T09:00:00.000Z',
    }),
  });

  time.advance(days(10));

  const onTheClock = await clock(app);

  // Entered last and listed first. Three wrong orderings are killed by this
  // one assertion: the order they were logged in, the order the rows come
  // back in, and furthest past its target — which would put SUB-001 first at
  // seventeen days over against SUB-009's five.
  expect(onTheClock.map((one) => one.number)).toEqual(['SUB-009', 'SUB-001']);
  expect(onTheClock.map((one) => one.inCourtMs)).toEqual([days(30), days(20)]);
  expect(onTheClock.map((one) => one.project.projectNumber)).toEqual([
    'T-2',
    'T-1',
  ]);
  // The ninety-day target and the one never in our court are not on the list.
  expect(onTheClock.every((one) => one.pastClock)).toBe(true);
});

// The `createdAt` tie-break is implemented and is not asserted here. Two
// entries with identical elapsed time come back from PostgreSQL in insertion
// order, which is `createdAt` order, so a test could not tell a specified sort
// from an accidental one — the same seam the submission ordering test records.

test("the clock for one job is that job's entries", async () => {
  const time = fakeTimeSource(new Date('2026-07-01T09:00:00.000Z'));
  const app = await api({ timeSource: time });
  const first = await job(app, 'T-1', 'Wren Street');
  const second = await job(app, 'T-2', 'Alcott Mill');

  await createRegisterEntry(app, first.submittals.id, {
    number: 'SUB-001',
    turnaroundDays: 3,
    ballInCourt: ours(),
  });
  await createRegisterEntry(app, second.submittals.id, {
    number: 'SUB-009',
    turnaroundDays: 3,
    ballInCourt: ours(),
  });

  time.advance(days(10));

  expect((await clock(app, first.project.id)).map((one) => one.number)).toEqual([
    'SUB-001',
  ]);
  expect((await clock(app, second.project.id)).map((one) => one.number)).toEqual([
    'SUB-009',
  ]);
  // And the count across every project is the length of the whole list.
  expect(await clock(app)).toHaveLength(2);
});

test('an archived project leaves the clock across every project and keeps its own', async () => {
  const time = fakeTimeSource(new Date('2026-07-01T09:00:00.000Z'));
  const app = await api({ timeSource: time });
  const { project, submittals } = await job(app);
  await createRegisterEntry(app, submittals.id, {
    number: 'SUB-001',
    turnaroundDays: 3,
    ballInCourt: ours(),
  });

  time.advance(days(10));
  expect(await clock(app)).toHaveLength(1);

  const archived = await post(app, `/v1/projects/${project.id}/archive`);
  expect(archived.status).toBe(200);

  // A finished job is not part of today's work, and asked about directly it
  // still answers — the line exposure draws in the same place.
  expect(await clock(app)).toEqual([]);
  expect((await clock(app, project.id)).map((one) => one.number)).toEqual([
    'SUB-001',
  ]);
});

test('the clock is empty when nothing is sitting in our court past its target', async () => {
  const app = await api();
  const { submittals } = await job(app);
  await createRegisterEntry(app, submittals.id, {
    turnaroundDays: 14,
    ballInCourt: ours(),
  });

  expect(await clock(app)).toEqual([]);
});

test('a handoff dated forward credits no time that has not elapsed', async () => {
  const time = fakeTimeSource(new Date('2026-07-01T09:00:00.000Z'));
  const app = await api({ timeSource: time });
  const { submittals } = await job(app);
  const logged = await createRegisterEntry(app, submittals.id, {
    turnaroundDays: 14,
    ballInCourt: ours(),
  });

  // A transmittal log is written up by hand and can carry a date that has not
  // arrived. Ten days have passed; this says the ball is ours again from the
  // twenty-first, which is ten days off.
  time.advance(days(10));
  await post(app, `/v1/register-entries/${logged.id}/handoffs`, {
    party: 'Us',
    inOurCourt: true,
    heldSince: '2026-07-21T09:00:00.000Z',
  });

  const read = await entry(app, logged.id);
  // Ten days and not twenty: an interval may not end after now, or the entry
  // would be past a fourteen-day clock on days that have not happened.
  expect(read.inCourtMs).toBe(days(10));
  expect(read.pastClock).toBe(false);
});
