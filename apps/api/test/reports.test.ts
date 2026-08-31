/**
 * The site visit report (issue #13).
 *
 * Everything below drives the real thing: a real BullMQ worker over the real
 * Redis, a real Chrome printing a real PDF, and the text read back out of that
 * PDF with a parser. Nothing about the rendering is substituted, which is why
 * the ticket's own criterion — "asserts the resulting document contains every
 * issue's stable identifier" — is asserted against a document and not a
 * stand-in for one.
 */

import { afterEach, expect, test } from 'vitest';
import {
  type SiteVisitDetail,
  type SiteVisitReportResponse,
  type TestApi,
  addPhoto,
  createIssue,
  createObservation,
  createProject,
  createSiteVisit,
  fakeTimeSource,
  generateReport,
  startFloor,
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

function post(app: TestApi, path: string, body?: unknown) {
  return app.fetch(path, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
}

const NO_SUCH = '2f1e6d8c-0000-4000-8000-000000000000';

async function visit(app: TestApi, id: string) {
  const response = await app.fetch(`/v1/site-visits/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as SiteVisitDetail;
}

/**
 * Waits for the worker to move a report along, which is not the same thing as
 * waiting for time to pass.
 *
 * Aging is tested by advancing the fake clock and never by sleeping, and that
 * rule holds: nothing here is aged. What is being waited on is a real worker
 * picking a real job up and a real browser printing it — `voice.test.ts`'s
 * `until`, with a longer deadline because a browser launch is on the far side
 * of it.
 */
async function until<T>(
  read: () => Promise<T | undefined>,
  what: string,
): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The report, once it has reached the state the test is about. */
function reaches(
  app: TestApi,
  siteVisitId: string,
  reportId: string,
  state: SiteVisitReportResponse['state'],
) {
  return until(async () => {
    const found = (await visit(app, siteVisitId)).reports.find(
      (report) => report.id === reportId,
    );
    if (found !== undefined && found.state === 'failed' && state !== 'failed') {
      // Said out loud rather than timed out against. A rendering that failed
      // will never reach `rendered`, and the vendor-less message on the row is
      // the whole diagnosis.
      throw new Error(`the rendering failed: ${found.failure}`);
    }
    return found !== undefined && found.state === state ? found : undefined;
  }, `report ${reportId} to be ${state}`);
}

/** The document's bytes, straight off the API. */
async function pdfOf(app: TestApi, reportId: string): Promise<Buffer> {
  const response = await app.fetch(`/v1/site-visit-reports/${reportId}/pdf`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/pdf');
  return Buffer.from(await response.arrayBuffer());
}

/**
 * The text of a PDF, read back with a parser.
 *
 * The assertions below are about what the engineer's client will read on the
 * page, so they are made against the rendered document rather than against the
 * HTML behind it. Items are joined with a space: a line of text arrives as
 * several of them, and a marker split across two would otherwise never match.
 */
async function documentText(bytes: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
  }).promise;

  const pages: string[] = [];
  for (let number = 1; number <= document.numPages; number += 1) {
    const content = await (await document.getPage(number)).getTextContent();
    pages.push(
      content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' '),
    );
  }
  return pages.join(' ');
}

/** A walk with a finding on it, which is what a report is mostly about. */
async function walked(app: TestApi, projectNumber: string) {
  const project = await createProject(app, projectNumber, 'Riverside clinic');
  const walk = await createSiteVisit(app, project.id, {
    startedAt: '2026-07-23T13:00:00.000Z',
    endedAt: '2026-07-23T16:20:00.000Z',
  });
  return { project, walk };
}

// ── Generating ──────────────────────────────────────────────────────────────

test('a report is generated as a queued job and renders to a PDF', async () => {
  const app = await api();
  const { walk } = await walked(app, 'R-1');

  const asked = await generateReport(app, walk.id);
  // Queued is all four stamps null, and the document is not there yet.
  expect(asked.state).toBe('queued');
  expect(asked.renderingSince).toBeNull();
  expect(asked.renderedAt).toBeNull();
  expect(asked.byteSize).toBeNull();

  const done = await reaches(app, walk.id, asked.id, 'rendered');
  expect(done.renderedAt).not.toBeNull();
  expect(done.failedAt).toBeNull();
  expect(done.byteSize).toBeGreaterThan(0);

  const pdf = await pdfOf(app, asked.id);
  // A real PDF, and the size the row claims it is.
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdf.byteLength).toBe(done.byteSize);
});

test('a report carries nothing that would let it disagree with the record', async () => {
  const app = await api();
  const { walk } = await walked(app, 'R-2');

  const report = await generateReport(app, walk.id);

  // The key its bytes are under never reaches the wire, as a photograph's and
  // a recording's do not. And there is no status column beside the four
  // stamps: this is the fourth record asked for one and the fourth to refuse,
  // so a status cannot be added without a failing test saying so.
  expect(Object.keys(report).sort()).toEqual([
    'byteSize',
    'createdAt',
    'failedAt',
    'failure',
    'id',
    'renderedAt',
    'renderingSince',
    'siteVisitId',
    'state',
  ]);
});

test('the generated report is retrievable from the visit', async () => {
  const app = await api();
  const { walk } = await walked(app, 'R-3');

  const asked = await generateReport(app, walk.id);
  await reaches(app, walk.id, asked.id, 'rendered');

  const [listed] = (await visit(app, walk.id)).reports;
  expect(listed?.id).toBe(asked.id);
  expect(listed?.state).toBe('rendered');
});

test('generating again is a second report and leaves the first standing', async () => {
  const app = await api();
  const { walk } = await walked(app, 'R-4');

  const first = await generateReport(app, walk.id);
  // The **finished** first report, not the queued body it was created with:
  // that one has every stamp still null, so comparing against it below would
  // compare null to null and pass whatever the second rendering did.
  const firstDone = await reaches(app, walk.id, first.id, 'rendered');
  expect(firstDone.renderedAt).not.toBeNull();

  // A correction is another rendering dated its own moment, the shape a
  // reissue and a rerun of a calculation have. Nothing edits the first.
  const second = await generateReport(app, walk.id);
  expect(second.id).not.toBe(first.id);
  const secondDone = await reaches(app, walk.id, second.id, 'rendered');
  expect(secondDone.renderedAt).not.toBe(firstDone.renderedAt);

  const reports = (await visit(app, walk.id)).reports;
  expect(reports.map((report) => report.id)).toEqual([first.id, second.id]);
  // The whole row, field for field. The second rendering wrote a new record
  // and touched nothing on this one — which is the whole claim.
  expect(reports[0]).toEqual(firstDone);
  expect((await pdfOf(app, first.id)).byteLength).toBeGreaterThan(0);
});

test('a report against a visit that does not exist is a 404', async () => {
  const app = await api();

  const response = await app.fetch(`/v1/site-visits/${NO_SUCH}/reports`, {
    method: 'POST',
  });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    message: 'no site visit with that id',
  });
});

// ── The document ────────────────────────────────────────────────────────────

test('the document prints every issue’s stable identifier', async () => {
  const app = await api();
  const { project, walk } = await walked(app, 'R-5');

  const first = await createObservation(app, walk.id, {
    observed: 'Fire rated wall penetration left unsealed above the ceiling',
    floor: '3',
    qualifier: 'Room 304 (electrical closet)',
    side: 'A',
  });
  const second = await createObservation(app, walk.id, {
    observed: 'Panel schedule does not match the installed breakers',
    floor: 'B1',
    qualifier: 'main switchgear',
    // Exactly one axis: the fixture defaults to a Side, and both is refused.
    side: undefined,
    sector: 'NW',
  });
  const one = await createIssue(app, first.id, 'Safety / Code');
  const two = await createIssue(app, second.id, 'Design / Coordination');

  const asked = await generateReport(app, walk.id);
  await reaches(app, walk.id, asked.id, 'rendered');
  const text = await documentText(await pdfOf(app, asked.id));

  // The ticket's own criterion. The identifier prints as the record's name and
  // the integer — nothing invented, the shape ADR-0030 gave a floor, where the
  // column holds `3` and the render supplies the word.
  expect(one.number).toBe(1);
  expect(two.number).toBe(2);
  expect(text).toContain('Issue 1');
  expect(text).toContain('Issue 2');

  // With their categories, in the words the register uses for them.
  expect(text).toContain('Safety / Code');
  expect(text).toContain('Design / Coordination');

  // And their locations, read off the sighting made on this walk.
  expect(text).toContain('Floor 3 — Room 304 (electrical closet), Side A');
  expect(text).toContain('Floor B1 — main switchgear, Sector NW');

  // The job it was against, so a number scoped to a project is readable.
  expect(text).toContain(project.projectNumber);
  expect(text).toContain('Riverside clinic');
});

test('the document carries the visit metadata and the per-floor schedule', async () => {
  const time = fakeTimeSource(new Date('2026-07-23T13:00:00.000Z'));
  const app = await api({ timeSource: time });
  const project = await createProject(app, 'R-6', 'Riverside clinic');
  const walk = await createSiteVisit(app, project.id, {
    startedAt: '2026-07-23T13:00:00.000Z',
    endedAt: '2026-07-23T16:20:00.000Z',
  });

  const floor = await startFloor(app, walk.id, '3', '2026-07-23T13:05:00.000Z');
  await app.fetch(`/v1/site-visit-floors/${floor.id}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ completedAt: '2026-07-23T13:50:00.000Z' }),
  });
  // Still being walked when the report was asked for: an open-ended window is
  // a real state of the schedule, and the document has to say so.
  await startFloor(app, walk.id, 'PH', '2026-07-23T14:10:00.000Z');

  const asked = await generateReport(app, walk.id);
  await reaches(app, walk.id, asked.id, 'rendered');
  const text = await documentText(await pdfOf(app, asked.id));

  expect(text).toContain('R-6');
  expect(text).toContain('Riverside clinic');
  expect(text).toContain('2026-07-23');
  expect(text).toContain('13:00');
  expect(text).toContain('16:20');
  expect(text).toContain('Floor 3');
  expect(text).toContain('13:05');
  expect(text).toContain('13:50');
  expect(text).toContain('Floor PH');
  expect(text).toContain('14:10');
});

test('non-issue observations are their own table, and come first', async () => {
  const app = await api();
  const { walk } = await walked(app, 'R-7');

  await createObservation(app, walk.id, {
    observed: 'Corridor lighting levels read as designed',
    floor: '2',
    qualifier: 'east corridor',
    side: 'B',
  });
  const promoted = await createObservation(app, walk.id, {
    observed: 'Fire rated wall penetration left unsealed',
    floor: '3',
    qualifier: 'Room 304 (electrical closet)',
    side: 'A',
  });
  await createIssue(app, promoted.id, 'Safety / Code');

  const asked = await generateReport(app, walk.id);
  await reaches(app, walk.id, asked.id, 'rendered');
  const text = await documentText(await pdfOf(app, asked.id));

  expect(text).toContain('Notable Observations (Non-Issues)');

  // The majority case, and the reason it comes first (story 56). The one that
  // became a finding is printed under that finding and not in this table.
  const table = text.indexOf('Notable Observations (Non-Issues)');
  const stayed = text.indexOf('Corridor lighting levels read as designed');
  const finding = text.indexOf('Issue 1');
  const became = text.indexOf('Fire rated wall penetration left unsealed');

  expect(table).toBeGreaterThanOrEqual(0);
  expect(stayed).toBeGreaterThan(table);
  expect(finding).toBeGreaterThan(stayed);
  expect(became).toBeGreaterThan(finding);
});

test('a finding first raised on an earlier walk still prints its identifier', async () => {
  const app = await api();
  const project = await createProject(app, 'R-14', 'Riverside clinic');

  // July: the finding is raised, and gets identifier 1.
  const july = await createSiteVisit(app, project.id, {
    startedAt: '2026-07-23T13:00:00.000Z',
    endedAt: '2026-07-23T16:20:00.000Z',
  });
  const raised = await createObservation(app, july.id, {
    observed: 'Fire rated wall penetration left unsealed',
    floor: '3',
    qualifier: 'Room 304 (electrical closet)',
    side: 'A',
  });
  const finding = await createIssue(app, raised.id, 'Safety / Code');
  expect(finding.number).toBe(1);

  // August: still there, and seen somewhere else on the floor.
  const august = await createSiteVisit(app, project.id, {
    startedAt: '2026-08-20T09:00:00.000Z',
    endedAt: '2026-08-20T11:00:00.000Z',
  });
  const again = await createObservation(app, august.id, {
    observed: 'Still unsealed, and the same detail repeats at the corridor wall',
    observedAt: '2026-08-20T09:40:00.000Z',
    floor: '3',
    qualifier: 'east corridor',
    side: 'A',
  });
  const response = await post(app, `/v1/issues/${finding.id}/observations/${again.id}`);
  // 204: the sighting is a join row and the route returns no body.
  expect(response.status).toBe(204);

  const asked = await generateReport(app, august.id);
  await reaches(app, august.id, asked.id, 'rendered');
  const text = await documentText(await pdfOf(app, asked.id));

  // The identifier is the one allocated in July and never renumbered — which
  // is what story 59 promises about a reference in an issued report.
  expect(text).toContain('Issue 1');
  // August's location, not July's: this report is August's.
  expect(text).toContain('Floor 3 — east corridor, Side A');
  expect(text).not.toContain('Room 304 (electrical closet)');
});

test('a finding not sighted on this walk is no part of this report', async () => {
  const app = await api();
  const project = await createProject(app, 'R-15', 'Riverside clinic');

  const july = await createSiteVisit(app, project.id, {
    startedAt: '2026-07-23T13:00:00.000Z',
    endedAt: '2026-07-23T16:20:00.000Z',
  });
  const raised = await createObservation(app, july.id, {
    observed: 'Fire rated wall penetration left unsealed',
    floor: '3',
    qualifier: 'Room 304 (electrical closet)',
    side: 'A',
  });
  await createIssue(app, raised.id, 'Safety / Code');

  // August: a photograph of that finding is added, and nothing is observed.
  // Binding by filename creates no **sighting** — a sighting is an observation
  // (ADR-0032) — so the finding is no part of this walk and prints nowhere.
  const august = await createSiteVisit(app, project.id, {
    startedAt: '2026-08-20T09:00:00.000Z',
    endedAt: '2026-08-20T11:00:00.000Z',
  });
  const photo = await addPhoto(app, august.id, {
    filename: '3-room 304-issue-1.png',
    takenAt: '2026-08-20T09:30:00.000Z',
  });
  expect(photo.issueNumber).toBe(1);

  const asked = await generateReport(app, august.id);
  await reaches(app, august.id, asked.id, 'rendered');
  const text = await documentText(await pdfOf(app, asked.id));

  // Deliberate, and pinned here so it stays a decision. An issue printed off a
  // photograph alone would have no location and no words to print beside it,
  // and the criterion asks for both.
  expect(text).toContain('No issues were raised on this visit.');
  expect(text).not.toContain('Issue 1');
});

test('an issue prints the photographs bound to it on this walk', async () => {
  const app = await api();
  const { walk } = await walked(app, 'R-8');

  const observation = await createObservation(app, walk.id, {
    observed: 'Fire rated wall penetration left unsealed',
    floor: '3',
    qualifier: 'Room 304 (electrical closet)',
    side: 'A',
  });
  await createIssue(app, observation.id, 'Safety / Code');

  const bound = await addPhoto(app, walk.id, {
    filename: '3-room 304-issue-1.png',
    takenAt: '2026-07-23T13:20:00.000Z',
  });
  expect(bound.issueNumber).toBe(1);

  const asked = await generateReport(app, walk.id);
  await reaches(app, walk.id, asked.id, 'rendered');
  const text = await documentText(await pdfOf(app, asked.id));

  // The evidence is captioned by the filename, which is the mechanism that
  // bound it and the name the engineer already has for it.
  expect(text).toContain('3-room 304-issue-1.png');
});

test('a walk with nothing on it still renders, and says so', async () => {
  const app = await api();
  const { walk } = await walked(app, 'R-9');

  const asked = await generateReport(app, walk.id);
  await reaches(app, walk.id, asked.id, 'rendered');
  const text = await documentText(await pdfOf(app, asked.id));

  expect(text).toContain('No issues were raised on this visit.');
  expect(text).toContain('No floors were recorded on the schedule.');
});

test('generating a report mutates no observation, issue or photo', async () => {
  const app = await api();
  const { project, walk } = await walked(app, 'R-10');

  const observation = await createObservation(app, walk.id, {
    observed: 'Fire rated wall penetration left unsealed',
    floor: '3',
    qualifier: 'Room 304 (electrical closet)',
    side: 'A',
  });
  await createIssue(app, observation.id, 'Safety / Code');
  await addPhoto(app, walk.id, {
    filename: '3-room 304-issue-1.png',
    takenAt: '2026-07-23T13:20:00.000Z',
  });

  const issues = () =>
    app
      .fetch(`/v1/projects/${project.id}/issues`)
      .then((response) => response.json());

  const before = await visit(app, walk.id);
  const issuesBefore = await issues();

  const asked = await generateReport(app, walk.id);
  await reaches(app, walk.id, asked.id, 'rendered');

  const { reports: _after, ...walkAfter } = await visit(app, walk.id);
  const { reports: _before, ...walkBefore } = before;
  // The report reads the record and writes nothing back to it. Everything it
  // prints is read at the moment of rendering, so a report cannot come to
  // disagree with the record it is a rendering of.
  expect(walkAfter).toEqual(walkBefore);
  expect(await issues()).toEqual(issuesBefore);
});

// ── Progress ────────────────────────────────────────────────────────────────

test('a report that has not rendered has no document to serve', async () => {
  // No worker, so nothing drains the queue and *queued* is a state the test
  // can stand in. Not a substitution: it is the API up with a job still
  // sitting in Redis, which is a state production has.
  const app = await api({ worker: false });
  const { walk } = await walked(app, 'R-11');

  const asked = await generateReport(app, walk.id);
  expect(asked.state).toBe('queued');

  const response = await app.fetch(`/v1/site-visit-reports/${asked.id}/pdf`);
  // Refused and not a 404: the report is there, and the difference between
  // "no such report" and "not rendered yet" is what the screen shows.
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    message: 'that report has not been rendered',
  });
});

test('the document of a report that does not exist is a 404', async () => {
  const app = await api();

  const response = await app.fetch(`/v1/site-visit-reports/${NO_SUCH}/pdf`);
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    message: 'no site visit report with that id',
  });
});

test('progress arrives over the stream as the rendering moves', async () => {
  const app = await api();
  const { walk } = await walked(app, 'R-12');

  const asked = await generateReport(app, walk.id);

  const abort = new AbortController();
  const stream = await app.fetch(`/v1/site-visits/${walk.id}/reports/stream`, {
    signal: abort.signal,
  });
  expect(stream.status).toBe(200);
  expect(stream.headers.get('content-type')).toBe('text/event-stream');

  const events = frames(stream);
  try {
    // The first event is the state right now, so a screen that opens on a
    // finished report is not left waiting for a change already made.
    const opening = await events.next();
    expect(opening[0]?.id).toBe(asked.id);

    const rendered = await until(async () => {
      const next = await events.next();
      return next[0]?.state === 'rendered' ? next : undefined;
    }, 'the rendered report to arrive on the stream');
    expect(rendered[0]?.byteSize).toBeGreaterThan(0);
  } finally {
    abort.abort();
  }
});

test('a stream for a visit that does not exist is a 404', async () => {
  const app = await api();

  const response = await app.fetch(`/v1/site-visits/${NO_SUCH}/reports/stream`);
  expect(response.status).toBe(404);
});

/** The event stream, one `data:` frame at a time. `voice.test.ts`'s reader. */
function frames(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = '';

  return {
    async next(): Promise<SiteVisitReportResponse[]> {
      for (;;) {
        const boundary = buffered.indexOf('\n\n');
        if (boundary !== -1) {
          const frame = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          // Heartbeats are comments and carry no data.
          if (frame.startsWith('data: ')) {
            return JSON.parse(frame.slice(6)) as SiteVisitReportResponse[];
          }
          continue;
        }
        const { done, value } = await reader.read();
        if (done) {
          throw new Error('the progress stream ended');
        }
        buffered += decoder.decode(value, { stream: true });
      }
    },
  };
}

// ── Nothing edits a report ──────────────────────────────────────────────────

test.each([['PATCH'], ['PUT'], ['DELETE']])(
  '%s on a report is a 404',
  async (method) => {
    const app = await api();
    const { walk } = await walked(app, `R-13-${method}`);
    const report = await generateReport(app, walk.id);

    // True by construction and not by a guard, as it is for a submission, an
    // issue and a photograph: a report is a record of one rendering, and a
    // correction is another one.
    const response = await app.fetch(`/v1/site-visit-reports/${report.id}`, {
      method,
    });
    expect(response.status).toBe(404);
  },
);
