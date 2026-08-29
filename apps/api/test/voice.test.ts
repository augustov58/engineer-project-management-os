import { afterEach, expect, test } from 'vitest';
import {
  A_SOUND,
  addVoiceCapture,
  createIssue,
  createProject,
  createSiteVisit,
  fakeTranscriber,
  heldTranscriber,
  refusingTranscriber,
  startTestApi,
  voiceCaptureBody,
  type SiteVisitDetail,
  type TestApi,
  type VoiceCaptureResponse,
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

async function visit(app: TestApi, id: string) {
  const response = await app.fetch(`/v1/site-visits/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as SiteVisitDetail;
}

/** A walk to record onto. */
async function walked(app: TestApi, projectNumber: string) {
  const project = await createProject(app, projectNumber, 'Voice capture');
  const walk = await createSiteVisit(app, project.id, {
    startedAt: '2026-07-23T12:30:00.000Z',
  });
  return { project, walk };
}

/**
 * Waits for a background job to change a record, which is not the same thing
 * as waiting for time to pass.
 *
 * Aging is tested by advancing the fake clock and never by sleeping, and that
 * rule still holds: nothing here is aged. What is being waited on is a real
 * BullMQ worker over a real Redis picking a job up, and there is no fake that
 * could stand in for it without the test no longer exercising the queue.
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
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The recording, once it has reached the state the test is about. */
function reaches(
  app: TestApi,
  siteVisitId: string,
  captureId: string,
  state: VoiceCaptureResponse['state'],
) {
  return until(async () => {
    const found = (await visit(app, siteVisitId)).voiceCaptures.find(
      (capture) => capture.id === captureId,
    );
    return found !== undefined && found.state === state ? found : undefined;
  }, `voice capture ${captureId} to be ${state}`);
}

/** The observation body every commit below starts from. */
function correction(patch: Record<string, unknown> = {}) {
  return {
    observed: 'Fire-rated wall penetration left unsealed above the ceiling',
    floor: '3',
    qualifier: 'Stair B',
    side: 'A',
    ...patch,
  };
}

// ── Recording an observation by speaking (story 51) ───────────────────────

test('a recording is added to a walk and starts out queued', async () => {
  const app = await api({ transcriber: heldTranscriber() });
  const { walk } = await walked(app, 'V-1');

  const response = await post(
    app,
    `/v1/site-visits/${walk.id}/voice-captures`,
    voiceCaptureBody(),
  );
  expect(response.status).toBe(201);

  const capture = (await response.json()) as VoiceCaptureResponse;
  expect(capture.siteVisitId).toBe(walk.id);
  expect(capture.contentType).toBe('audio/webm');
  expect(capture.recordedAt).toBe('2026-07-23T13:20:00.000Z');
  expect(capture.byteSize).toBe(Buffer.from(A_SOUND, 'base64').byteLength);
  expect(capture.state).toBe('queued');
  expect(capture.transcript).toBeNull();
  expect(capture.observation).toBeNull();
});

test('a recording carries neither its audio nor the key it is under', async () => {
  const app = await api({ transcriber: heldTranscriber() });
  const { walk } = await walked(app, 'V-2');

  const capture = await addVoiceCapture(app, walk.id);

  // The exact key set, so neither the bytes nor the object key can be added
  // to the wire without a failing test saying so.
  expect(Object.keys(capture).sort()).toEqual([
    'byteSize',
    'captureKey',
    'contentType',
    'createdAt',
    'failedAt',
    'failure',
    'id',
    'observation',
    'recordedAt',
    'siteVisitId',
    'state',
    'transcribedAt',
    'transcribingSince',
    'transcript',
  ]);
});

test('the walk lists what was spoken on it, in the order it was said', async () => {
  const app = await api();
  const { walk } = await walked(app, 'V-3');

  const second = await addVoiceCapture(app, walk.id, {
    captureKey: 'second-recording-key',
    recordedAt: '2026-07-23T14:00:00.000Z',
  });
  const first = await addVoiceCapture(app, walk.id, {
    captureKey: 'first-recording-key',
    recordedAt: '2026-07-23T13:00:00.000Z',
  });

  const listed = (await visit(app, walk.id)).voiceCaptures.map((one) => one.id);
  expect(listed).toEqual([first.id, second.id]);
});

test('a recording against a walk that is not there is refused', async () => {
  const app = await api();
  const response = await post(
    app,
    `/v1/site-visits/${NO_SUCH}/voice-captures`,
    voiceCaptureBody(),
  );
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ message: 'no site visit with that id' });
});

test('the boundary refuses what a phone browser cannot have produced', async () => {
  const app = await api();
  const { walk } = await walked(app, 'V-4');
  const path = `/v1/site-visits/${walk.id}/voice-captures`;

  // A type outside the closed set of three. The read route hands this value
  // straight to a browser, so it is refused here and by a CHECK underneath.
  expect(
    (await post(app, path, voiceCaptureBody({ contentType: 'text/html' })))
      .status,
  ).toBe(400);

  // No audio at all is not a recording of anything.
  expect(
    (await post(app, path, voiceCaptureBody({ bytes: '' }))).status,
  ).toBe(400);

  // The instant is required, and pointedly does not fall back to the clock.
  const { recordedAt: _omitted, ...withoutTime } = voiceCaptureBody();
  expect((await post(app, path, withoutTime)).status).toBe(400);

  // A key has to be a key, not a sentence.
  expect(
    (await post(app, path, voiceCaptureBody({ captureKey: 'a walk' }))).status,
  ).toBe(400);
});

// ── Losing signal in a building, and reconciling (story 112) ──────────────

test('the same recording sent twice lands once and answers with the row', async () => {
  const app = await api({ transcriber: heldTranscriber() });
  const { walk } = await walked(app, 'V-5');

  const first = await addVoiceCapture(app, walk.id);

  // The phone kept the recording because it never saw the first answer, and
  // sent it again when the signal came back.
  const again = await post(
    app,
    `/v1/site-visits/${walk.id}/voice-captures`,
    voiceCaptureBody(),
  );

  // 200 and not 409: a refusal would not tell the phone whether the first
  // attempt landed, and it would then keep the recording or throw it away.
  expect(again.status).toBe(200);
  expect(((await again.json()) as VoiceCaptureResponse).id).toBe(first.id);

  // One recording on the walk, not two.
  expect((await visit(app, walk.id)).voiceCaptures).toHaveLength(1);
});

test('the same key on another walk is another recording', async () => {
  const app = await api();
  const { project } = await walked(app, 'V-6');
  const morning = await createSiteVisit(app, project.id, {
    startedAt: '2026-07-23T09:00:00.000Z',
  });
  const afternoon = await createSiteVisit(app, project.id, {
    startedAt: '2026-07-24T09:00:00.000Z',
  });

  const one = await addVoiceCapture(app, morning.id);
  const other = await addVoiceCapture(app, afternoon.id);
  expect(other.id).not.toBe(one.id);
});

// ── The queue, the port, and the states between them ──────────────────────

test('a queued recording is transcribed and carries what the vendor heard', async () => {
  const app = await api({ transcriber: fakeTranscriber('Panel schedule missing') });
  const { walk } = await walked(app, 'V-7');

  const capture = await addVoiceCapture(app, walk.id);
  const done = await reaches(app, walk.id, capture.id, 'transcribed');

  expect(done.transcript).toBe('Panel schedule missing');
  expect(done.transcribedAt).not.toBeNull();
  expect(done.failedAt).toBeNull();
  expect(done.failure).toBeNull();
  // Still a draft: nothing has become an observation.
  expect(done.observation).toBeNull();
  expect((await visit(app, walk.id)).observations).toEqual([]);
});

test('transcribing is a state the screen can stand in', async () => {
  const vendor = heldTranscriber('Held, then said');
  const app = await api({ transcriber: vendor });
  const { walk } = await walked(app, 'V-8');

  const capture = await addVoiceCapture(app, walk.id);
  await vendor.reached;

  const working = await reaches(app, walk.id, capture.id, 'transcribing');
  expect(working.transcribingSince).not.toBeNull();
  expect(working.transcript).toBeNull();

  vendor.release();
  const done = await reaches(app, walk.id, capture.id, 'transcribed');
  expect(done.transcript).toBe('Held, then said');
});

// ── A failed or rejected transcription leaves the audio recoverable ───────

test('a vendor that refuses leaves the recording failed and the audio readable', async () => {
  const app = await api({
    transcriber: refusingTranscriber('audio too short to transcribe'),
  });
  const { walk } = await walked(app, 'V-9');

  const capture = await addVoiceCapture(app, walk.id);
  const failed = await reaches(app, walk.id, capture.id, 'failed');

  expect(failed.failure).toBe('audio too short to transcribe');
  expect(failed.failedAt).not.toBeNull();
  expect(failed.transcript).toBeNull();

  // The recoverable half: the audio is exactly what was sent.
  const audio = await app.fetch(`/v1/voice-captures/${capture.id}/audio`);
  expect(audio.status).toBe(200);
  expect(audio.headers.get('content-type')).toBe('audio/webm');
  expect(audio.headers.get('x-content-type-options')).toBe('nosniff');
  expect(Buffer.from(await audio.arrayBuffer())).toEqual(
    Buffer.from(A_SOUND, 'base64'),
  );
});

test('a failed recording is still committed by hand, which is the point', async () => {
  const app = await api({ transcriber: refusingTranscriber('vendor is down') });
  const { walk } = await walked(app, 'V-10');

  const capture = await addVoiceCapture(app, walk.id);
  await reaches(app, walk.id, capture.id, 'failed');

  const committed = await post(
    app,
    `/v1/voice-captures/${capture.id}/observation`,
    correction({ observed: 'Typed from the audio after the vendor failed' }),
  );
  expect(committed.status).toBe(201);

  const walkNow = await visit(app, walk.id);
  expect(walkNow.observations).toHaveLength(1);
  expect(walkNow.observations[0]?.observed).toBe(
    'Typed from the audio after the vendor failed',
  );
});

test('retrying clears the failure and transcribes on the second attempt', async () => {
  // One vendor, refusing until the test swaps what it does — which is what a
  // vendor being down and then not being down looks like from here.
  let answer: () => Promise<string> = () =>
    Promise.reject(new Error('vendor is down'));
  const app = await api({ transcriber: { transcribe: () => answer() } });
  const { walk } = await walked(app, 'V-11');

  const capture = await addVoiceCapture(app, walk.id);
  await reaches(app, walk.id, capture.id, 'failed');

  answer = () => Promise.resolve('Said on the second attempt');
  const retried = await post(app, `/v1/voice-captures/${capture.id}/retry`);
  expect(retried.status).toBe(200);

  // The failure is cleared the moment it is retried, not when it succeeds.
  const reset = (await retried.json()) as VoiceCaptureResponse;
  expect(reset.state).toBe('queued');
  expect(reset.failure).toBeNull();
  expect(reset.failedAt).toBeNull();

  const done = await reaches(app, walk.id, capture.id, 'transcribed');
  expect(done.transcript).toBe('Said on the second attempt');
});

test('a recording stuck at queued is retried, because a job can be lost', async () => {
  // Redis has no volume in this stack and `queue.add` can throw after the row
  // is written, so a recording can sit queued with nothing behind it. The row
  // is the durable half, and this is the way back — the screen offers it here
  // as well as on a failure.
  const vendor = heldTranscriber('Said on the second asking');
  const app = await api({ transcriber: vendor });
  const { walk } = await walked(app, 'V-21');

  const capture = await addVoiceCapture(app, walk.id);

  const response = await post(app, `/v1/voice-captures/${capture.id}/retry`);
  expect(response.status).toBe(200);
  expect(((await response.json()) as VoiceCaptureResponse).state).toBe('queued');

  vendor.release();
  const done = await reaches(app, walk.id, capture.id, 'transcribed');
  expect(done.transcript).toBe('Said on the second asking');
});

test('retrying what has already been transcribed is refused, not repeated', async () => {
  const app = await api({ transcriber: fakeTranscriber('The first answer') });
  const { walk } = await walked(app, 'V-12');

  const capture = await addVoiceCapture(app, walk.id);
  await reaches(app, walk.id, capture.id, 'transcribed');

  const response = await post(app, `/v1/voice-captures/${capture.id}/retry`);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    message: 'that voice capture has already been transcribed',
  });

  // And the words the engineer may be part-way through correcting stand.
  const still = (await visit(app, walk.id)).voiceCaptures[0];
  expect(still?.transcript).toBe('The first answer');
});

test('retrying what has already been committed is refused', async () => {
  const app = await api({ transcriber: refusingTranscriber('vendor is down') });
  const { walk } = await walked(app, 'V-13');

  const capture = await addVoiceCapture(app, walk.id);
  await reaches(app, walk.id, capture.id, 'failed');
  expect(
    (
      await post(
        app,
        `/v1/voice-captures/${capture.id}/observation`,
        correction(),
      )
    ).status,
  ).toBe(201);

  const response = await post(app, `/v1/voice-captures/${capture.id}/retry`);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    message: 'that voice capture has already become an observation',
  });
});

test('a recording that is not there answers the same way everywhere', async () => {
  const app = await api();
  const missing = { message: 'no voice capture with that id' };

  const audio = await app.fetch(`/v1/voice-captures/${NO_SUCH}/audio`);
  expect(audio.status).toBe(404);
  expect(await audio.json()).toEqual(missing);

  const retry = await post(app, `/v1/voice-captures/${NO_SUCH}/retry`);
  expect(retry.status).toBe(404);
  expect(await retry.json()).toEqual(missing);

  const commit = await post(
    app,
    `/v1/voice-captures/${NO_SUCH}/observation`,
    correction(),
  );
  expect(commit.status).toBe(404);
  expect(await commit.json()).toEqual(missing);
});

// ── The draft, corrected, becoming an observation (story 52) ──────────────

test('the corrected words become the observation and the transcript stands', async () => {
  const app = await api({
    transcriber: fakeTranscriber('fire rated wall pen a straight left on sealed'),
  });
  const { walk } = await walked(app, 'V-14');

  const capture = await addVoiceCapture(app, walk.id);
  await reaches(app, walk.id, capture.id, 'transcribed');

  const response = await post(
    app,
    `/v1/voice-captures/${capture.id}/observation`,
    correction(),
  );
  expect(response.status).toBe(201);

  const committed = (await response.json()) as VoiceCaptureResponse;
  expect(committed.observation?.observed).toBe(
    'Fire-rated wall penetration left unsealed above the ceiling',
  );
  expect(committed.observation?.location).toBe('Floor 3 — Stair B, Side A');

  // What the vendor heard is untouched. Two facts, both kept, which is what
  // makes "transcription error never became record error" checkable.
  expect(committed.transcript).toBe(
    'fire rated wall pen a straight left on sealed',
  );

  // And it is an ordinary observation: it reads in the walk's list, and it can
  // become a finding like any other.
  const walkNow = await visit(app, walk.id);
  expect(walkNow.observations).toHaveLength(1);
  const finding = await createIssue(app, walkNow.observations[0]!.id);
  expect(finding.number).toBe(1);
});

test('an observation from a recording is dated when it was spoken', async () => {
  const app = await api();
  const { walk } = await walked(app, 'V-15');

  const capture = await addVoiceCapture(app, walk.id, {
    recordedAt: '2026-07-23T13:20:00.000Z',
  });
  await reaches(app, walk.id, capture.id, 'transcribed');

  const response = await post(
    app,
    `/v1/voice-captures/${capture.id}/observation`,
    correction(),
  );
  const committed = (await response.json()) as VoiceCaptureResponse;

  // Not the evening it was reviewed. The engineer was standing there at 13:20,
  // and issue #11 bins photographs against exactly this kind of stamp.
  expect(committed.observation?.observedAt).toBe('2026-07-23T13:20:00.000Z');
});

test('a corrected time still wins, because a correction may be about the time', async () => {
  const app = await api();
  const { walk } = await walked(app, 'V-16');

  const capture = await addVoiceCapture(app, walk.id);
  await reaches(app, walk.id, capture.id, 'transcribed');

  const response = await post(
    app,
    `/v1/voice-captures/${capture.id}/observation`,
    correction({ observedAt: '2026-07-23T13:05:00.000Z' }),
  );
  const committed = (await response.json()) as VoiceCaptureResponse;
  expect(committed.observation?.observedAt).toBe('2026-07-23T13:05:00.000Z');
});

test('the location grammar is refused here exactly as it is when typed', async () => {
  const app = await api();
  const { walk } = await walked(app, 'V-17');
  const capture = await addVoiceCapture(app, walk.id);
  const path = `/v1/voice-captures/${capture.id}/observation`;

  // Both axes: they never combine into one string (story 55).
  expect(
    (await post(app, path, correction({ sector: '4' }))).status,
  ).toBe(400);

  // Neither: the grammar has no optional segment for a form to leave empty.
  const { side: _dropped, ...noAxis } = correction();
  expect((await post(app, path, noAxis)).status).toBe(400);

  // And nothing was written by either refusal.
  expect((await visit(app, walk.id)).observations).toEqual([]);
});

test('committing twice is refused and writes no second observation', async () => {
  const app = await api();
  const { walk } = await walked(app, 'V-18');

  const capture = await addVoiceCapture(app, walk.id);
  await reaches(app, walk.id, capture.id, 'transcribed');
  const path = `/v1/voice-captures/${capture.id}/observation`;

  expect((await post(app, path, correction())).status).toBe(201);

  const again = await post(app, path, correction({ observed: 'Said twice' }));
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({
    message: 'that voice capture has already become an observation',
  });

  // One observation, not two. A number of observations is not a thing this
  // product can take back.
  expect((await visit(app, walk.id)).observations).toHaveLength(1);
});

// ── Progress while it runs ────────────────────────────────────────────────

test('progress arrives over the stream as the transcription moves', async () => {
  const vendor = heldTranscriber('Arrived over the stream');
  const app = await api({ transcriber: vendor });
  const { walk } = await walked(app, 'V-19');

  const capture = await addVoiceCapture(app, walk.id);

  const abort = new AbortController();
  const stream = await app.fetch(
    `/v1/site-visits/${walk.id}/voice-captures/stream`,
    { signal: abort.signal },
  );
  expect(stream.status).toBe(200);
  expect(stream.headers.get('content-type')).toBe('text/event-stream');

  const events = frames(stream);
  try {
    // The first event is the state right now, so a screen that opens on a
    // finished transcription is not left waiting for a change already made.
    const opening = await events.next();
    expect(opening[0]?.id).toBe(capture.id);

    await vendor.reached;
    vendor.release();

    const spoken = await until(async () => {
      const next = await events.next();
      return next[0]?.state === 'transcribed' ? next : undefined;
    }, 'the transcript to arrive on the stream');
    expect(spoken[0]?.transcript).toBe('Arrived over the stream');
  } finally {
    abort.abort();
  }
});

test('a stream for a walk that is not there is refused', async () => {
  const app = await api();
  const response = await app.fetch(
    `/v1/site-visits/${NO_SUCH}/voice-captures/stream`,
  );
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    message: 'no site visit with that id',
  });
});

// ── Nothing edits or deletes a recording ──────────────────────────────────

test('nothing edits or deletes a recording', async () => {
  const app = await api();
  const { walk } = await walked(app, 'V-20');
  const capture = await addVoiceCapture(app, walk.id);
  const path = `/v1/voice-captures/${capture.id}`;

  for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
    // A `DELETE` carries no body, and declaring a JSON content-type without
    // one is refused by Fastify before routing — which would make this assert
    // 400 and never reach the question it is asking.
    const response = await app.fetch(path, {
      method,
      ...(method === 'DELETE'
        ? {}
        : { headers: json, body: JSON.stringify({ transcript: 'x' }) }),
    });
    // No such route at all, which is how "never rewritten" is true by
    // construction rather than by a guard — as it is for a submission and an
    // issue. The filename was the mechanism there; the transcript is the
    // vendor's own words here, and a correction is the observation.
    expect(response.status).toBe(404);
  }

  expect((await visit(app, walk.id)).voiceCaptures).toHaveLength(1);
});

/**
 * The `data:` payloads of a server-sent event stream, one call at a time.
 *
 * Written here rather than in the harness because one test file reads a
 * stream, and a thing used by exactly one record lives with that record.
 */
function frames(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = '';

  return {
    async next(): Promise<VoiceCaptureResponse[]> {
      for (;;) {
        const boundary = buffered.indexOf('\n\n');
        if (boundary !== -1) {
          const frame = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          // Heartbeats are comments and carry no data.
          if (frame.startsWith('data: ')) {
            return JSON.parse(frame.slice(6)) as VoiceCaptureResponse[];
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
