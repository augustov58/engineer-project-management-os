import { afterEach, expect, test } from 'vitest';
import {
  assumptionRecordBody,
  createAssumptionRecord,
  createPhase,
  createProject,
  createSubmission,
  fakeTimeSource,
  openItemBody,
  reissueSubmission,
  startTestApi,
  type AssumptionRecordResponse,
  type ExposureRow,
  type OpenItemResponse,
  type SubmissionDetail,
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

/** A project with a phase, which is all a submission needs to exist. */
async function job(app: TestApi, number: string, name: string) {
  const project = await createProject(app, number, name);
  const phase = await createPhase(app, project.id, '90% CD');
  return { project, phase };
}

/** A project with a phase and one issuance, which is all a record needs. */
async function issued(app: TestApi, number: string, name: string) {
  const project = await createProject(app, number, name);
  const phase = await createPhase(app, project.id, '90% CD');
  const submission = await createSubmission(app, project.id, {
    phaseId: phase.id,
  });
  return { project, phase, submission };
}

async function records(app: TestApi, submissionId: string) {
  const response = await app.fetch(
    `/v1/submissions/${submissionId}/assumption-records`,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as AssumptionRecordResponse[];
}

async function submission(app: TestApi, id: string) {
  const response = await app.fetch(`/v1/submissions/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as SubmissionDetail;
}

async function exposure(app: TestApi, projectId?: string) {
  const path =
    projectId === undefined
      ? '/v1/exposure'
      : `/v1/exposure?projectId=${projectId}`;
  const response = await app.fetch(path);
  expect(response.status).toBe(200);
  return (await response.json()) as ExposureRow[];
}

/** Raising a flag as an open item, which is the whole of story 40. */
function raise(
  app: TestApi,
  recordId: string,
  line: number,
  body: Record<string, unknown>,
) {
  return post(
    app,
    `/v1/assumption-records/${recordId}/flags/${line}/open-item`,
    body,
  );
}

function writeCounterfactual(
  app: TestApi,
  recordId: string,
  line: number,
  counterfactual: string,
) {
  return post(
    app,
    `/v1/assumption-records/${recordId}/assumptions/${line}/counterfactual`,
    { counterfactual },
  );
}

/**
 * An open item body with no `unresolved`, which is how a caller says "take the
 * flag's own wording". Everything else on an open item is engineering
 * judgement and is still required.
 */
function fromFlag(patch: Record<string, unknown> = {}) {
  return openItemBody({ unresolved: undefined, ...patch });
}

// ── Capture is verbatim, and that is the whole point ───────────────────────

test('the two blocks come back byte-for-byte as they were captured', async () => {
  const app = await api();
  const { submission: set } = await issued(app, 'A-1', 'Riverside clinic');

  // Leading indent, a blank line inside the block, a tab, a non-ASCII
  // character and a trailing newline — every one of them a thing a helper
  // skill really emits and a trim would silently eat.
  const assumptions =
    'ASSUMPTIONS:\n  - Secondary OCPD present\n\n  -\tSDS: Δ-Y, separately derived\n';
  const flags = 'FLAGS / VERIFY:\n  ! Electrode type not given\n';

  const response = await post(
    app,
    `/v1/submissions/${set.id}/assumption-records`,
    assumptionRecordBody({ assumptions, flags }),
  );

  expect(response.status).toBe(201);
  const created = (await response.json()) as AssumptionRecordResponse;
  expect(created.assumptions).toBe(assumptions);
  expect(created.flags).toBe(flags);

  // And the same on the way back out, which is where a normalising read would
  // show up instead.
  const [stored] = await records(app, set.id);
  expect(stored?.assumptions).toBe(assumptions);
  expect(stored?.flags).toBe(flags);
});

test('a record carries the code edition, which may name several standards', async () => {
  const app = await api();
  const { submission: set } = await issued(app, 'A-2', 'Harbour school');

  const codeEdition =
    'NEC 2023, NFPA 110-2025, NFPA 101-2024, NFPA 99-2024, NFPA 20-2022';
  const record = await createAssumptionRecord(app, set.id, { codeEdition });

  expect(record.codeEdition).toBe(codeEdition);
  expect(record.submissionId).toBe(set.id);
});

test('the date is the engineer’s, or the injected time source', async () => {
  const time = fakeTimeSource(new Date('2026-03-02T09:00:00.000Z'));
  const app = await api({ timeSource: time });
  const { submission: set } = await issued(app, 'A-3', 'Depot fit-out');

  // The calculation was run months before the row existed, so the date is
  // settable — ADR-0026's argument for `issued_at`, applied here.
  const backdated = await createAssumptionRecord(app, set.id, {
    calculatedAt: '2025-11-14T00:00:00.000Z',
  });
  expect(backdated.calculatedAt).toBe('2025-11-14T00:00:00.000Z');

  const today = await createAssumptionRecord(app, set.id);
  expect(today.calculatedAt).toBe('2026-03-02T09:00:00.000Z');
});

test('capturing against a submission that does not exist is a 404', async () => {
  const app = await api();
  const response = await post(
    app,
    '/v1/submissions/2f1e6d8c-0000-4000-8000-000000000000/assumption-records',
    assumptionRecordBody(),
  );

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    message: 'no submission with that id',
  });
});

test.each([
  ['assumptions', '   '],
  ['flags', '\n\t '],
  ['codeEdition', ' '],
])('a blank %s is refused rather than stored', async (field, blank) => {
  const app = await api();
  const { submission: set } = await issued(app, `B-${field}`, 'Blank fields');

  const response = await post(
    app,
    `/v1/submissions/${set.id}/assumption-records`,
    assumptionRecordBody({ [field]: blank }),
  );

  expect(response.status).toBe(400);
  expect(await records(app, set.id)).toHaveLength(0);
});

test('records list oldest calculation first', async () => {
  const app = await api();
  const { submission: set } = await issued(app, 'A-4', 'Two calculations');

  const later = await createAssumptionRecord(app, set.id, {
    calculatedAt: '2026-02-01T00:00:00.000Z',
    codeEdition: 'NEC 2023',
  });
  const earlier = await createAssumptionRecord(app, set.id, {
    calculatedAt: '2026-01-05T00:00:00.000Z',
    codeEdition: 'NEC 2017',
  });

  expect((await records(app, set.id)).map((row) => row.id)).toEqual([
    earlier.id,
    later.id,
  ]);
});

test('a record is bound to one submission and reads only from it', async () => {
  const app = await api();
  const { submission: mine } = await issued(app, 'A-5', 'Bound here');
  const { submission: other } = await issued(app, 'A-6', 'Not here');

  await createAssumptionRecord(app, mine.id);

  expect(await records(app, mine.id)).toHaveLength(1);
  expect(await records(app, other.id)).toHaveLength(0);
});

// ── The blocks are line-addressed, and the lines are derived ───────────────

test('each block comes back split into its lines, numbered from zero', async () => {
  const app = await api();
  const { submission: set } = await issued(app, 'C-1', 'Lines');

  const record = await createAssumptionRecord(app, set.id);

  expect(record.assumptionLines.map((row) => row.line)).toEqual([0, 1, 2, 3]);
  expect(record.assumptionLines[0]).toEqual({
    line: 0,
    text: 'ASSUMPTIONS:',
    counterfactual: null,
  });
  expect(record.assumptionLines[2]?.text).toBe('  - Secondary OCPD present');

  expect(record.flagLines).toHaveLength(3);
  expect(record.flagLines[1]).toEqual({
    line: 1,
    text: '  ! 125% sec FLA wants 300A but the downstream panel bus is 225A.',
    openItem: null,
  });
});

// ── A counterfactual per assumed input (story 39) ──────────────────────────

test('a counterfactual is written against the assumed input it is about', async () => {
  const app = await api();
  const { submission: set } = await issued(app, 'D-1', 'Counterfactuals');
  const record = await createAssumptionRecord(app, set.id);

  const consequence =
    'If the OCPD is primary-only the secondary conductors lose their protection path';
  const response = await writeCounterfactual(app, record.id, 2, consequence);
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ line: 2, counterfactual: consequence });

  const [stored] = await records(app, set.id);
  expect(stored?.assumptionLines[2]?.counterfactual).toBe(consequence);
  // Written against one input and no other.
  expect(stored?.assumptionLines[1]?.counterfactual).toBeNull();
  expect(stored?.assumptionLines[3]?.counterfactual).toBeNull();
});

test('a second counterfactual on the same input is refused, not overwritten', async () => {
  const app = await api();
  const { submission: set } = await issued(app, 'D-2', 'No silent overwrite');
  const record = await createAssumptionRecord(app, set.id);

  expect((await writeCounterfactual(app, record.id, 1, 'The first')).status).toBe(
    201,
  );

  const second = await writeCounterfactual(app, record.id, 1, 'The second');
  expect(second.status).toBe(409);
  expect(await second.json()).toEqual({
    message: 'that assumed input already carries a counterfactual',
  });

  const [stored] = await records(app, set.id);
  expect(stored?.assumptionLines[1]?.counterfactual).toBe('The first');
});

test('a blank line carries no counterfactual, because it is not an input', async () => {
  const app = await api();
  const { submission: set } = await issued(app, 'D-3', 'Blank line');
  const record = await createAssumptionRecord(app, set.id, {
    assumptions: 'ASSUMPTIONS:\n\n  - Secondary OCPD present',
  });

  const response = await writeCounterfactual(app, record.id, 1, 'Nothing');
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    message: 'that line of the assumptions block is blank',
  });
});

test('a line the block does not have is a 404', async () => {
  const app = await api();
  const { submission: set } = await issued(app, 'D-4', 'Past the end');
  const record = await createAssumptionRecord(app, set.id);

  const response = await writeCounterfactual(app, record.id, 99, 'Nothing');
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    message: 'that block has no line with that number',
  });
});

test('a counterfactual against a record that does not exist is a 404', async () => {
  const app = await api();
  const response = await writeCounterfactual(
    app,
    '2f1e6d8c-0000-4000-8000-000000000000',
    0,
    'Nothing',
  );

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    message: 'no assumption record with that id',
  });
});

// ── A flag becomes an open item (story 40) ─────────────────────────────────

test('raising a flag takes its wording verbatim and puts the item on the project', async () => {
  const app = await api();
  const { project, submission: set } = await issued(app, 'E-1', 'Raise a flag');
  const record = await createAssumptionRecord(app, set.id);

  const response = await raise(app, record.id, 2, fromFlag());
  expect(response.status).toBe(201);

  const item = (await response.json()) as OpenItemResponse;
  // Pre-filled from the flag: nothing about it is transcribed by hand.
  expect(item.unresolved).toBe(
    '! Electrode type not given (--electrode): the full Table 250.66 GEC is shown.',
  );
  // The subject stays the project (ADR-0026). An item that vanished from the
  // project screen the moment it was tied to a set would be the opposite of
  // "nothing sitting in my court".
  expect(item.subjectType).toBe('PROJECT');
  expect(item.subjectId).toBe(project.id);
  expect(item.resolvedAt).toBeNull();

  const [stored] = await records(app, set.id);
  expect(stored?.flagLines[2]?.openItem?.id).toBe(item.id);
  expect(stored?.flagLines[1]?.openItem).toBeNull();
});

test('the raised item is attached to the submission the record justified', async () => {
  const app = await api();
  const { submission: set } = await issued(app, 'E-2', 'Attached');
  const record = await createAssumptionRecord(app, set.id);

  const response = await raise(app, record.id, 1, fromFlag());
  const item = (await response.json()) as OpenItemResponse;

  const detail = await submission(app, set.id);
  expect(detail.openItems.map((row) => row.id)).toEqual([item.id]);
  // Attached after the issuance, so no part of what went out (ADR-0027) —
  // which is also what makes it detachable again.
  expect(detail.openItems[0]?.unresolvedAtIssuance).toBeNull();
});

test('a raised flag makes the submission currently provisional and exposed', async () => {
  const app = await api();
  const { project, submission: set } = await issued(app, 'E-3', 'Exposure');
  const record = await createAssumptionRecord(app, set.id);

  const before = await submission(app, set.id);
  expect(before.issuedProvisional).toBe(false);
  expect(before.currentlyProvisional).toBe(false);
  expect(await exposure(app, project.id)).toHaveLength(0);

  const raised = await raise(app, record.id, 1, fromFlag());
  const item = (await raised.json()) as OpenItemResponse;

  const after = await submission(app, set.id);
  expect(after.currentlyProvisional).toBe(true);
  // What the set went out on is untouched: the flag was raised afterwards and
  // cannot rewrite the moment of issuance (ADR-0027).
  expect(after.issuedProvisional).toBe(false);
  expect((await exposure(app, project.id)).map((row) => row.id)).toEqual([
    set.id,
  ]);

  // Answering the flag takes the set out of exposure and leaves the record of
  // it standing.
  const resolved = await post(app, `/v1/open-items/${item.id}/resolve`, {
    note: 'Ring electrode confirmed by the contractor',
  });
  expect(resolved.status).toBe(200);

  const answered = await submission(app, set.id);
  expect(answered.currentlyProvisional).toBe(false);
  expect(answered.issuedProvisional).toBe(false);
  expect(await exposure(app, project.id)).toHaveLength(0);

  // The flag still points at the item it became, which is how the record
  // shows that it was raised rather than forgotten.
  const [stored] = await records(app, set.id);
  expect(stored?.flagLines[1]?.openItem?.id).toBe(item.id);
  expect(stored?.flagLines[1]?.openItem?.resolvedAt).not.toBeNull();
});

test('the raiser may say what is unresolved in their own words instead', async () => {
  const app = await api();
  const { submission: set } = await issued(app, 'E-4', 'Own words');
  const record = await createAssumptionRecord(app, set.id);

  const response = await raise(
    app,
    record.id,
    1,
    openItemBody({ unresolved: 'Panel bus rating at LP-1' }),
  );
  expect(response.status).toBe(201);
  expect(((await response.json()) as OpenItemResponse).unresolved).toBe(
    'Panel bus rating at LP-1',
  );
});

test('raising the same flag twice is refused rather than repeated', async () => {
  const app = await api();
  const { submission: set } = await issued(app, 'E-5', 'Once only');
  const record = await createAssumptionRecord(app, set.id);

  expect((await raise(app, record.id, 1, fromFlag())).status).toBe(201);

  const again = await raise(app, record.id, 1, fromFlag());
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({
    message: 'that flag has already been raised as an open item',
  });

  // And the refusal left nothing behind: one item, not two.
  expect((await submission(app, set.id)).openItems).toHaveLength(1);
});

test('a blank line is not a flag and cannot be raised', async () => {
  const app = await api();
  const { submission: set } = await issued(app, 'E-6', 'Blank flag');
  const record = await createAssumptionRecord(app, set.id, {
    flags: 'FLAGS / VERIFY:\n   \n  ! Electrode type not given',
  });

  const response = await raise(app, record.id, 1, fromFlag());
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    message: 'that line of the flags block is blank',
  });
  expect((await submission(app, set.id)).openItems).toHaveLength(0);
});

test('a flag line the block does not have is a 404', async () => {
  const app = await api();
  const { submission: set } = await issued(app, 'E-7', 'Past the end');
  const record = await createAssumptionRecord(app, set.id);

  const response = await raise(app, record.id, 99, fromFlag());
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    message: 'that block has no line with that number',
  });
});

test('raising from a record that does not exist is a 404', async () => {
  const app = await api();
  const response = await raise(
    app,
    '2f1e6d8c-0000-4000-8000-000000000000',
    0,
    fromFlag(),
  );

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    message: 'no assumption record with that id',
  });
});

test('a flag too long to be an open item on its own says so', async () => {
  const app = await api();
  const { submission: set } = await issued(app, 'E-8', 'Very long flag');
  const record = await createAssumptionRecord(app, set.id, {
    flags: `FLAGS / VERIFY:\n  ! ${'x'.repeat(600)}`,
  });

  const response = await raise(app, record.id, 1, fromFlag());
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    message:
      'that flag is too long to become an open item on its own; say what is unresolved',
  });

  // Saying it in fewer words is accepted, so the flag is never unraisable.
  expect(
    (
      await raise(
        app,
        record.id,
        1,
        openItemBody({ unresolved: 'The long flag, in short' }),
      )
    ).status,
  ).toBe(201);
});

// ── Nothing edits a record, for the reason nothing edits a submission ──────

test.each(['PATCH', 'PUT', 'DELETE'])(
  '%s on an assumption record is refused and changes nothing',
  async (method) => {
    const app = await api();
    const { submission: set } = await issued(app, `F-${method}`, 'Append only');
    const record = await createAssumptionRecord(app, set.id);

    // A DELETE carries no body, and so no content-type either: sending one
    // would be refused for the empty body and never reach the router, which
    // is the thing being asserted about.
    const carries = method !== 'DELETE';
    const response = await app.fetch(`/v1/assumption-records/${record.id}`, {
      method,
      ...(carries
        ? { headers: json, body: JSON.stringify({ flags: 'gone' }) }
        : {}),
    });
    // There is no such route, which is what makes this true by construction
    // rather than by a guard that can be forgotten.
    expect(response.status, method).toBe(404);

    const [after] = await records(app, set.id);
    expect(after).toEqual(record);
  },
);

// ── A reissue is a different submission, and carries its own reasoning ─────

test('a reissue does not inherit the superseded set’s assumption records', async () => {
  const app = await api();
  const { submission: first } = await issued(app, 'G-1', 'Reissued');
  await createAssumptionRecord(app, first.id);

  const second = await reissueSubmission(app, first.id, { revision: 'Rev 2' });

  // The record stays on the issuance it justified. A rerun of the calculation
  // is captured against the reissue, and the two sit side by side.
  expect(await records(app, first.id)).toHaveLength(1);
  expect(await records(app, second.id)).toHaveLength(0);
});

test('an item raised from a flag cannot be detached from the submission', async () => {
  const app = await api();
  const { project, submission: set } = await issued(app, 'H-1', 'Not droppable');
  const record = await createAssumptionRecord(app, set.id);

  const raised = await raise(app, record.id, 1, fromFlag());
  const item = (await raised.json()) as OpenItemResponse;

  // Attached after the issuance, so ADR-0027's own rule would let it come off
  // — and letting it would be a flag raised and then dropped.
  const response = await app.fetch(
    `/v1/submissions/${set.id}/open-items/${item.id}`,
    { method: 'DELETE' },
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    message: 'that open item was raised from a flag on this submission',
  });

  // Refused, and nothing moved: the set still rests on it and still counts.
  const detail = await submission(app, set.id);
  expect(detail.openItems.map((row) => row.id)).toEqual([item.id]);
  expect(detail.currentlyProvisional).toBe(true);
  expect((await exposure(app, project.id)).map((row) => row.id)).toEqual([
    set.id,
  ]);
});

test('a raised item attached by hand to another set detaches from that one', async () => {
  const app = await api();
  const { project, phase } = await job(app, 'H-2', 'Two sets');
  const first = await createSubmission(app, project.id, { phaseId: phase.id });
  const second = await createSubmission(app, project.id, {
    phaseId: phase.id,
    revision: 'Rev 2',
  });

  const record = await createAssumptionRecord(app, first.id);
  const item = (await (await raise(app, record.id, 1, fromFlag())).json()) as
    OpenItemResponse;

  // On the second set it *was* attached by hand, so it is a typo like any
  // other and comes off. The refusal is about the set the flag was raised on.
  const attached = await post(
    app,
    `/v1/submissions/${second.id}/open-items/${item.id}`,
  );
  expect(attached.status).toBe(204);

  const response = await app.fetch(
    `/v1/submissions/${second.id}/open-items/${item.id}`,
    { method: 'DELETE' },
  );
  expect(response.status).toBe(204);

  expect((await submission(app, second.id)).openItems).toHaveLength(0);
  expect((await submission(app, first.id)).openItems).toHaveLength(1);
});
