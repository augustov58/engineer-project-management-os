import { afterEach, expect, test } from 'vitest';
import type { AgentRunService } from '../src/agent.js';
import {
  createProject,
  heldAgentRunService,
  refusingAgentRunService,
  requestMemoryRun,
  sseFrames,
  startTestApi,
  writeMemory,
  type AgentRunResponse,
  type AuditEntryResponse,
  type MemoryProposalResponse,
  type MemoryResponse,
  type MemoryVersionResponse,
  type ProjectResponse,
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

async function memory(app: TestApi, projectId: string) {
  const response = await app.fetch(`/v1/projects/${projectId}/memory`);
  expect(response.status).toBe(200);
  return (await response.json()) as MemoryResponse;
}

async function versions(app: TestApi, projectId: string) {
  const response = await app.fetch(
    `/v1/projects/${projectId}/memory/versions`,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as MemoryVersionResponse[];
}

async function runs(app: TestApi, projectId: string) {
  const response = await app.fetch(`/v1/projects/${projectId}/memory/runs`);
  expect(response.status).toBe(200);
  return (await response.json()) as AgentRunResponse[];
}

async function proposals(app: TestApi, projectId: string) {
  const response = await app.fetch(
    `/v1/projects/${projectId}/memory/proposals`,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as MemoryProposalResponse[];
}

async function auditTrail(app: TestApi, projectId: string) {
  const response = await app.fetch(`/v1/projects/${projectId}/memory/audit`);
  expect(response.status).toBe(200);
  return (await response.json()) as AuditEntryResponse[];
}

/**
 * Waits for a background job to change a record, which is not the same thing
 * as waiting for time to pass — the helper voice.test.ts wrote, copied for
 * the same reason: what is being waited on is a real BullMQ worker over a
 * real Redis picking a job up, and there is no fake that could stand in for
 * it without the test no longer exercising the queue.
 */
async function until<T>(
  read: () => Promise<T | undefined>,
  what: string,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The run, once it has reached the state the test is about. */
async function runReaches(
  app: TestApi,
  projectId: string,
  runId: string,
  state: AgentRunResponse['state'],
) {
  return until(async () => {
    const found = (await runs(app, projectId)).find((run) => run.id === runId);
    return found !== undefined && found.state === state ? found : undefined;
  }, `agent run ${runId} to be ${state}`);
}

/**
 * A project with one finished run behind it, which is what a pending proposal
 * needs. The default `fakeAgentRunService` does the proposing, through the
 * same internal route the real adapter's tool calls.
 */
async function proposed(
  app: TestApi,
  project: ProjectResponse,
): Promise<MemoryProposalResponse> {
  const run = await requestMemoryRun(app, project.id);
  await runReaches(app, project.id, run.id, 'finished');
  const proposal = (await proposals(app, project.id)).find(
    (one) => one.runId === run.id,
  );
  if (proposal === undefined) {
    throw new Error('fixture failed: the finished run proposed nothing');
  }
  return proposal;
}

// ── The memory itself ────────────────────────────────────────────────────

test('a project with no memory reads as none, with the budget beside it', async () => {
  const app = await api();
  const project = await createProject(app, 'M-1', 'Office fit-out');

  const found = await memory(app, project.id);

  // The exact key set, so a column cannot be added to what a memory is
  // without a failing test saying so.
  expect(Object.keys(found).sort()).toEqual([
    'budget',
    'content',
    'projectId',
    'size',
    'versionedAt',
    'versions',
  ]);
  expect(found.projectId).toBe(project.id);
  expect(found.content).toBeNull();
  expect(found.versions).toBe(0);
  expect(found.size).toBe(0);
  expect(found.versionedAt).toBeNull();
  // The budget is a number the interface surfaces, and it is deliberately
  // small: about a page and a half of prose, not a dumping ground.
  expect(found.budget).toBe(4_000);
});

test('the engineer writes memory directly, and the write is a new version', async () => {
  const app = await api();
  const project = await createProject(app, 'M-1', 'Office fit-out');

  const response = await post(app, `/v1/projects/${project.id}/memory`, {
    content: 'The riser is sized for the 350 A alternative.',
  });
  expect(response.status).toBe(201);
  const written = (await response.json()) as MemoryResponse;
  expect(written.content).toBe('The riser is sized for the 350 A alternative.');
  expect(written.versions).toBe(1);
  expect(written.size).toBe(written.content?.length);
  expect(written.versionedAt).not.toBeNull();

  const after = await memory(app, project.id);
  expect(after).toEqual(written);
});

test('every write is a version and the current memory is the latest', async () => {
  const app = await api();
  const project = await createProject(app, 'M-1', 'Office fit-out');

  await writeMemory(app, project.id, 'First: sized for 350 A.');
  await writeMemory(app, project.id, 'Second: the client chose 400 A.');

  const found = await memory(app, project.id);
  expect(found.content).toBe('Second: the client chose 400 A.');
  expect(found.versions).toBe(2);

  const history = await versions(app, project.id);
  expect(history.map((version) => version.content)).toEqual([
    'First: sized for 350 A.',
    'Second: the client chose 400 A.',
  ]);
  for (const version of history) {
    expect(Object.keys(version).sort()).toEqual([
      'content',
      'createdAt',
      'id',
      'projectId',
      'proposalId',
    ]);
    expect(version.proposalId).toBeNull();
  }
});

test('memory is retrieved by project identity, and an unknown project is a 404', async () => {
  const app = await api();
  const one = await createProject(app, 'M-1', 'Office fit-out');
  const other = await createProject(app, 'M-2', 'Warehouse');
  await writeMemory(app, one.id, "M-1's reasoning.");

  // There is no query parameter, no search and no ranking (ADR-0019): the
  // memory is read through the job it belongs to.
  expect((await memory(app, one.id)).content).toBe("M-1's reasoning.");
  expect((await memory(app, other.id)).content).toBeNull();

  for (const path of [
    `/v1/projects/${NO_SUCH}/memory`,
    `/v1/projects/${NO_SUCH}/memory/versions`,
    `/v1/projects/${NO_SUCH}/memory/runs`,
    `/v1/projects/${NO_SUCH}/memory/proposals`,
    `/v1/projects/${NO_SUCH}/memory/audit`,
  ]) {
    const response = await app.fetch(path);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { message: string }).message).toBe(
      'no project with that id',
    );
  }
  expect(
    (await post(app, `/v1/projects/${NO_SUCH}/memory`, { content: 'x' })).status,
  ).toBe(404);
  expect((await post(app, `/v1/projects/${NO_SUCH}/memory/runs`)).status).toBe(
    404,
  );
});

test('a blank or oversized memory is refused at the boundary', async () => {
  const app = await api();
  const project = await createProject(app, 'M-1', 'Office fit-out');

  expect(
    (await post(app, `/v1/projects/${project.id}/memory`, { content: '   ' }))
      .status,
  ).toBe(400);
  expect(
    (
      await post(app, `/v1/projects/${project.id}/memory`, {
        content: 'x'.repeat(32_769),
      })
    ).status,
  ).toBe(400);
  expect((await memory(app, project.id)).versions).toBe(0);
});

test('nothing edits or deletes a version, a proposal or a run', async () => {
  const app = await api();
  const project = await createProject(app, 'M-1', 'Office fit-out');
  await writeMemory(app, project.id, 'Sized for 350 A.');
  const proposal = await proposed(app, project);

  // As it is for a submission, an issue and a photograph: the record types
  // that are never edited refuse the verbs by not existing.
  for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
    for (const path of [
      `/v1/projects/${project.id}/memory`,
      `/v1/memory-proposals/${proposal.id}`,
      `/v1/memory-runs/${proposal.runId}`,
    ]) {
      const response = await app.fetch(path, { method });
      expect(response.status).toBe(404);
    }
  }
  expect((await memory(app, project.id)).content).toBe('Sized for 350 A.');
});

// ── The agent proposes; the human confirms ───────────────────────────────

test('asking for a proposal queues a run, which the worker settles', async () => {
  const app = await api();
  const project = await createProject(app, 'M-1', 'Office fit-out');

  const run = await requestMemoryRun(app, project.id);
  expect(Object.keys(run).sort()).toEqual([
    'createdAt',
    'failedAt',
    'failure',
    'finishedAt',
    'id',
    'projectId',
    'runningSince',
    'state',
  ]);

  const settled = await runReaches(app, project.id, run.id, 'finished');
  expect(settled.runningSince).not.toBeNull();
  expect(settled.failedAt).toBeNull();
  expect(settled.failure).toBeNull();
});

test('a run proposes through the internal API and memory does not move until the engineer accepts', async () => {
  const app = await api();
  const project = await createProject(app, 'M-1', 'Office fit-out');
  await writeMemory(app, project.id, 'Sized for 350 A.');

  const proposal = await proposed(app, project);

  // The exact key set, so a column cannot be added to what a proposal is
  // without a failing test saying so.
  expect(Object.keys(proposal).sort()).toEqual([
    'acceptedAt',
    'baseContent',
    'createdAt',
    'id',
    'projectId',
    'proposed',
    'rejectedAt',
    'runId',
    'state',
  ]);
  expect(proposal.state).toBe('pending');
  expect(proposal.proposed).toContain('[fake agent proposal');
  // The base is what the memory said when the proposal was written — the
  // snapshot the review's diff is computed against.
  expect(proposal.baseContent).toBe('Sized for 350 A.');

  // The ticket's criterion: no proposal commits without confirmation. The
  // run finished, the proposal arrived, and the memory is exactly what the
  // engineer last wrote.
  const found = await memory(app, project.id);
  expect(found.content).toBe('Sized for 350 A.');
  expect(found.versions).toBe(1);
});

test('accepting a proposal commits its text as a new version', async () => {
  const app = await api();
  const project = await createProject(app, 'M-1', 'Office fit-out');
  await writeMemory(app, project.id, 'Sized for 350 A.');
  const proposal = await proposed(app, project);

  const response = await post(
    app,
    `/v1/memory-proposals/${proposal.id}/accept`,
    {},
  );
  expect(response.status).toBe(200);
  const after = (await response.json()) as MemoryResponse;
  expect(after.content).toBe(proposal.proposed);
  expect(after.versions).toBe(2);

  const [resolved] = await proposals(app, project.id);
  expect(resolved?.state).toBe('accepted');
  expect(resolved?.acceptedAt).not.toBeNull();
  expect(resolved?.rejectedAt).toBeNull();

  // The version points at the proposal it committed, so which words came
  // from which proposal is a fact of the record.
  const history = await versions(app, project.id);
  expect(history[1]?.proposalId).toBe(proposal.id);
});

test('the engineer edits the proposal before accepting, and the agent\'s words stand', async () => {
  const app = await api();
  const project = await createProject(app, 'M-1', 'Office fit-out');
  const proposal = await proposed(app, project);

  const response = await post(app, `/v1/memory-proposals/${proposal.id}/accept`, {
    content: 'Kept: the decision about the riser, corrected.',
  });
  expect(response.status).toBe(200);

  // What was committed is the engineer's text; what the agent proposed is
  // still on the proposal, so the correction is checkable afterwards.
  expect((await memory(app, project.id)).content).toBe(
    'Kept: the decision about the riser, corrected.',
  );
  const [resolved] = await proposals(app, project.id);
  expect(resolved?.state).toBe('accepted');
  expect(resolved?.proposed).toContain('[fake agent proposal');
});

test('rejecting a proposal writes nothing to memory', async () => {
  const app = await api();
  const project = await createProject(app, 'M-1', 'Office fit-out');
  await writeMemory(app, project.id, 'Sized for 350 A.');
  const proposal = await proposed(app, project);

  const response = await post(app, `/v1/memory-proposals/${proposal.id}/reject`);
  expect(response.status).toBe(200);
  expect(((await response.json()) as MemoryProposalResponse).state).toBe(
    'rejected',
  );

  const found = await memory(app, project.id);
  expect(found.content).toBe('Sized for 350 A.');
  expect(found.versions).toBe(1);
});

test('a resolved proposal refuses a second answer', async () => {
  const app = await api();
  const project = await createProject(app, 'M-1', 'Office fit-out');
  const accepted = await proposed(app, project);
  const rejected = await proposed(app, project);

  for (const proposal of [accepted, rejected]) {
    const first =
      proposal === accepted
        ? await post(app, `/v1/memory-proposals/${proposal.id}/accept`, {})
        : await post(app, `/v1/memory-proposals/${proposal.id}/reject`);
    expect(first.status).toBe(200);

    for (const verb of ['accept', 'reject'] as const) {
      const again = await post(
        app,
        `/v1/memory-proposals/${proposal.id}/${verb}`,
        verb === 'accept' ? {} : undefined,
      );
      expect(again.status).toBe(409);
      expect(((await again.json()) as { message: string }).message).toBe(
        'that proposal is already resolved',
      );
    }
  }

  expect(
    (await post(app, `/v1/memory-proposals/${NO_SUCH}/accept`, {})).status,
  ).toBe(404);
  expect(
    (await post(app, `/v1/memory-proposals/${NO_SUCH}/reject`)).status,
  ).toBe(404);
});

test('one run proposes at most once', async () => {
  const app = await api();
  const project = await createProject(app, 'M-1', 'Office fit-out');
  const proposal = await proposed(app, project);

  // The agent's tool landing twice — a model calling it again, or a retry of
  // the call — is refused by the unique run_id rather than by a guard.
  const again = await post(app, `/v1/memory-runs/${proposal.runId}/proposal`, {
    content: 'A second proposal from the same run.',
  });
  expect(again.status).toBe(409);
  expect((await proposals(app, project.id)).length).toBe(1);

  expect(
    (await post(app, `/v1/memory-runs/${NO_SUCH}/proposal`, { content: 'x' }))
      .status,
  ).toBe(404);
});

// ── The states between asking and answering ──────────────────────────────

test('a run with no worker stays queued, which production has too', async () => {
  const app = await api({ worker: false });
  const project = await createProject(app, 'M-1', 'Office fit-out');

  const run = await requestMemoryRun(app, project.id);

  // All four stamps null, derived: the job is sitting in Redis and nothing
  // has picked it up.
  expect(run.state).toBe('queued');
  expect(run.runningSince).toBeNull();
  expect(run.finishedAt).toBeNull();
  expect(run.failedAt).toBeNull();
  expect(run.failure).toBeNull();
});

test('a held run reads as running, and settles when the agent answers', async () => {
  const held = heldAgentRunService();
  const app = await api({ agentRunService: held.service });
  const project = await createProject(app, 'M-1', 'Office fit-out');

  const run = await requestMemoryRun(app, project.id);
  await held.reached;

  const running = (await runs(app, project.id)).find(
    (found) => found.id === run.id,
  );
  expect(running?.state).toBe('running');
  expect(running?.runningSince).not.toBeNull();

  held.release();
  const settled = await runReaches(app, project.id, run.id, 'finished');
  // The held service proposed nothing, so a finished run can leave no
  // proposal behind: the agent is asked, not ordered.
  expect(settled.finishedAt).not.toBeNull();
  expect(await proposals(app, project.id)).toEqual([]);
});

test('a failing run is recorded with the reason and proposes nothing', async () => {
  const app = await api({
    agentRunService: refusingAgentRunService('no model provider is configured'),
  });
  const project = await createProject(app, 'M-1', 'Office fit-out');

  const run = await requestMemoryRun(app, project.id);
  const failed = await runReaches(app, project.id, run.id, 'failed');

  // The reason is the service's own sentence, the way a capture carries the
  // transcription vendor's.
  expect(failed.failure).toBe('no model provider is configured');
  expect(failed.failedAt).not.toBeNull();
  expect(await proposals(app, project.id)).toEqual([]);
});

test('the agent is handed the run and the project, and never the database', async () => {
  const seen: { runId: string; projectId: string }[] = [];
  const recording: AgentRunService = {
    proposeMemoryEdit: (request) => {
      seen.push(request);
      return Promise.resolve();
    },
  };
  const app = await api({ agentRunService: recording });
  const project = await createProject(app, 'M-1', 'Office fit-out');

  const run = await requestMemoryRun(app, project.id);
  await runReaches(app, project.id, run.id, 'finished');

  // The port's whole surface: one method, handed the run and the job. What
  // the agent reads and proposes goes through the internal API from there.
  expect(seen).toEqual([{ runId: run.id, projectId: project.id }]);
});

// ── The audit ────────────────────────────────────────────────────────────

test('every mutation writes an audit entry, in the order it happened', async () => {
  const app = await api();
  const project = await createProject(app, 'M-1', 'Office fit-out');

  await writeMemory(app, project.id, 'Sized for 350 A.');
  const accepted = await proposed(app, project);
  await post(app, `/v1/memory-proposals/${accepted.id}/accept`, {
    content: 'Edited before accepting.',
  });
  const rejected = await proposed(app, project);
  await post(app, `/v1/memory-proposals/${rejected.id}/reject`);

  const trail = await auditTrail(app, project.id);
  expect(
    trail.map((entry) => entry.action),
  ).toEqual([
    'memory written',
    'proposal written',
    'proposal accepted with edits',
    'proposal written',
    'proposal rejected',
  ]);
  for (const entry of trail) {
    expect(Object.keys(entry).sort()).toEqual([
      'action',
      'createdAt',
      'detail',
      'id',
      'projectId',
    ]);
    expect(entry.projectId).toBe(project.id);
  }

  // Append-only: no route updates or deletes one, as everywhere else.
  for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
    const first = trail[0];
    expect(first).toBeDefined();
    const response = await app.fetch(
      `/v1/audit-entries/${first?.id}`,
      { method },
    );
    expect(response.status).toBe(404);
  }
});

test('an accept that edits nothing reads as a plain accept in the audit', async () => {
  const app = await api();
  const project = await createProject(app, 'M-1', 'Office fit-out');
  const proposal = await proposed(app, project);

  await post(app, `/v1/memory-proposals/${proposal.id}/accept`, {});

  const trail = await auditTrail(app, project.id);
  expect(trail.map((entry) => entry.action)).toEqual([
    'proposal written',
    'proposal accepted',
  ]);
});

// ── The stream ───────────────────────────────────────────────────────────

test('the stream pushes the runs and proposals as they move', async () => {
  const app = await api();
  const project = await createProject(app, 'M-1', 'Office fit-out');

  const abort = new AbortController();
  const stream = await app.fetch(
    `/v1/projects/${project.id}/memory/stream`,
    { signal: abort.signal },
  );
  expect(stream.status).toBe(200);
  expect(stream.headers.get('content-type')).toBe('text/event-stream');

  const events = sseFrames<{
    runs: AgentRunResponse[];
    proposals: MemoryProposalResponse[];
  }>(stream);
  try {
    // The first event is the state right now: no runs, no proposals.
    const opening = await events.next();
    expect(opening).toEqual({ runs: [], proposals: [] });

    await requestMemoryRun(app, project.id);
    const moved = await until(async () => {
      const next = await events.next();
      return next.proposals.length === 1 ? next : undefined;
    }, 'the proposal to arrive on the stream');
    expect(moved.runs[0]?.state).toBe('finished');
    expect(moved.proposals[0]?.state).toBe('pending');
  } finally {
    abort.abort();
  }
});
