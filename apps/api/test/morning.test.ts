import { afterEach, expect, test } from 'vitest';
import {
  createOpenItem,
  createPhase,
  createProject,
  createRegisterEntry,
  createSubmission,
  fakeTimeSource,
  handoffBody,
  listRegisters,
  startTestApi,
  type ClockRow,
  type ExposureRow,
  type TestApi,
} from './harness.js';

/**
 * The morning screen (issue #16, stories 42-48): the two daily counts read
 * together, which is the one thing neither `exposure.test.ts` nor the clock
 * section of `registers.test.ts` can assert on its own.
 *
 * Each of those files proves its own count. What the morning screen promises
 * is about the **pair**: that they are two lists and never a third figure
 * derived from both (ADR-0016), that the roll-up across every live job is what
 * the per-job reads say, and that both are right on the very next read after
 * the record underneath one of them changes — with nothing invalidated,
 * rebuilt or re-enqueued in between (story 48).
 *
 * There is no morning-screen endpoint and this file drives none. Both counts
 * are the lengths of the two lists the screen already links to, which is the
 * whole of why a count and the records it counted cannot disagree (ADR-0027,
 * ADR-0037) — a `GET /v1/morning` returning `{ exposure: 3, clock: 2 }` would
 * be exactly the combined payload ADR-0016 exists to refuse.
 */

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

/** Milliseconds, written the way the clock tests already write them. */
function days(count: number): number {
  return count * 24 * 60 * 60 * 1000;
}

/** The first count, across every live job or within one. */
async function exposure(
  app: TestApi,
  projectId?: string,
): Promise<ExposureRow[]> {
  const path =
    projectId === undefined
      ? '/v1/exposure'
      : `/v1/exposure?projectId=${projectId}`;
  const response = await app.fetch(path);
  expect(response.status).toBe(200);
  return (await response.json()) as ExposureRow[];
}

/** The second. Exposure's route shape exactly (ADR-0037). */
async function clock(app: TestApi, projectId?: string): Promise<ClockRow[]> {
  const path =
    projectId === undefined ? '/v1/clock' : `/v1/clock?projectId=${projectId}`;
  const response = await app.fetch(path);
  expect(response.status).toBe(200);
  return (await response.json()) as ClockRow[];
}

/** A handoff that puts the ball in our court, which is what the clock reads. */
function ours() {
  return handoffBody({ party: 'Us', inOurCourt: true });
}

/**
 * A job carrying exactly one of each: an issuance standing on an unresolved
 * open item, and a submittal in our court against a three-day turnaround.
 *
 * Ten days of the injected clock puts the entry past its target and neither
 * count anywhere near the other, so a test that mixed them up would fail.
 */
async function job(app: TestApi, number: string, name: string) {
  const project = await createProject(app, number, name);
  const phase = await createPhase(app, project.id, '90% CD');
  const item = await createOpenItem(app, project.id);
  const issued = await createSubmission(app, project.id, {
    phaseId: phase.id,
    openItemIds: [item.id],
  });
  // Submittals first, and there are always exactly two (ADR-0036).
  const [submittals] = await listRegisters(app, project.id);
  const entry = await createRegisterEntry(app, submittals!.id, {
    number: `${number}-SUB-001`,
    turnaroundDays: 3,
    ballInCourt: ours(),
  });
  return { project, item, issued, entry };
}

async function resolve(app: TestApi, itemId: string) {
  const response = await post(app, `/v1/open-items/${itemId}/resolve`, {
    note: 'Confirmed by the contractor',
  });
  expect(response.status).toBe(200);
}

async function dispose(app: TestApi, entryId: string) {
  const response = await post(
    app,
    `/v1/register-entries/${entryId}/disposition`,
    {
      disposition: 'Approved as Noted',
      ballInCourt: { party: 'Acme Mechanical', inOurCourt: false },
    },
  );
  expect(response.status).toBe(200);
}

// ── Both counts are right on the next read (story 48) ─────────────────────

test('both counts change on the next read after an item resolves and a disposition lands', async () => {
  const time = fakeTimeSource(new Date('2026-07-01T09:00:00.000Z'));
  const app = await api({ timeSource: time });
  const { project, item, issued, entry } = await job(app, 'T-1', 'Wren Street');

  time.advance(days(10));

  // What the screen shows this morning: two counts side by side, each the
  // length of the list it links to.
  expect((await exposure(app)).map((row) => row.id)).toEqual([issued.id]);
  expect((await clock(app)).map((row) => row.id)).toEqual([entry.id]);

  // The two changes the ticket names by name, in one morning's work.
  await resolve(app, item.id);
  await dispose(app, entry.id);

  // The very next read. Nothing was invalidated, no aggregate was rebuilt and
  // no job was enqueued between the write and this line — both counts are
  // queries over the records that just changed, which is what makes "correct
  // the moment it lands" a property rather than a promise about refreshing.
  expect(await exposure(app)).toEqual([]);
  expect(await clock(app)).toEqual([]);
  // And the per-job reads the project screen makes, which are the same query.
  expect(await exposure(app, project.id)).toEqual([]);
  expect(await clock(app, project.id)).toEqual([]);
});

test('an entry handed back to us returns to the clock while its disposition stands', async () => {
  const time = fakeTimeSource(new Date('2026-07-01T09:00:00.000Z'));
  const app = await api({ timeSource: time });
  const { entry } = await job(app, 'T-1', 'Wren Street');

  time.advance(days(10));
  expect((await clock(app)).map((row) => row.id)).toEqual([entry.id]);

  await dispose(app, entry.id);
  expect(await clock(app)).toEqual([]);

  // The ball comes back — the reviewed set returns with comments to answer.
  // Nothing un-records the disposition, and nothing restarts a clock, because
  // there is no clock to restart: the count is an arithmetic over the handoffs
  // and reads whatever the history now says (ADR-0037).
  const back = await post(
    app,
    `/v1/register-entries/${entry.id}/handoffs`,
    ours(),
  );
  expect(back.status).toBe(201);

  time.advance(days(5));

  const onTheClock = await clock(app);
  expect(onTheClock.map((row) => row.id)).toEqual([entry.id]);
  expect(onTheClock[0]!.disposition).toBe('Approved as Noted');
  // Ten days before the review, five since it came back. The interval we did
  // not hold it is not counted against us.
  expect(onTheClock[0]!.inCourtMs).toBe(days(15));
});

// ── The roll-up is what the per-job reads say (story 46) ──────────────────

test('the roll-up across every job is exactly the per-job reads put together', async () => {
  const time = fakeTimeSource(new Date('2026-07-01T09:00:00.000Z'));
  const app = await api({ timeSource: time });
  const one = await job(app, 'T-1', 'Wren Street');
  const two = await job(app, 'T-2', 'Alcott Mill');

  time.advance(days(10));

  const across = { exposure: await exposure(app), clock: await clock(app) };
  const perJob = {
    exposure: [
      ...(await exposure(app, one.project.id)),
      ...(await exposure(app, two.project.id)),
    ],
    clock: [
      ...(await clock(app, one.project.id)),
      ...(await clock(app, two.project.id)),
    ],
  };

  // One morning screen covers all the live jobs, and the number on it is the
  // number the project screens add up to — because it is one query narrowed,
  // not a second one that happens to agree today.
  expect(across.exposure.map((row) => row.id).sort()).toEqual(
    perJob.exposure.map((row) => row.id).sort(),
  );
  expect(across.clock.map((row) => row.id).sort()).toEqual(
    perJob.clock.map((row) => row.id).sort(),
  );
  expect(across.exposure).toHaveLength(2);
  expect(across.clock).toHaveLength(2);

  // Each count lands on exactly the records it counted, naming the job, so a
  // roll-up is something the engineer can act on rather than reconstruct.
  expect(across.exposure.map((row) => row.project.projectNumber).sort()).toEqual(
    ['T-1', 'T-2'],
  );
  expect(across.clock.map((row) => row.project.projectNumber).sort()).toEqual([
    'T-1',
    'T-2',
  ]);

  // Resolving one job's item moves that job's count and leaves the other's.
  await resolve(app, one.item.id);
  expect((await exposure(app)).map((row) => row.id)).toEqual([two.issued.id]);
  expect(await exposure(app, one.project.id)).toEqual([]);
  expect(await clock(app)).toHaveLength(2);
});

// ── Two counts, never a third figure derived from them (ADR-0016) ─────────

test('the clock is a count and nothing else — no score, ratio or percentage', async () => {
  const time = fakeTimeSource(new Date('2026-07-01T09:00:00.000Z'));
  const app = await api({ timeSource: time });
  await job(app, 'T-1', 'Wren Street');
  time.advance(days(10));

  // The assertion `exposure.test.ts` makes about the first count, made about
  // the second: the morning screen shows both, and ADR-0016's prohibition is
  // structural only if it holds for each. A payload that is an array has
  // nothing to combine a second figure with.
  const response = await app.fetch('/v1/clock');
  const body = (await response.json()) as unknown;
  expect(Array.isArray(body)).toBe(true);

  const combined = /score|ratio|percent|health|index|rating/i;
  const fields = Object.keys((body as ClockRow[])[0]!);
  expect(fields.filter((field) => combined.test(field))).toEqual([]);
});
