/**
 * The two vendor adapters and the environment that selects them (issue #109).
 *
 * **No test here calls a vendor.** The seam is the `fetch` each adapter is
 * built with: every case below hands it a function that answers the way the
 * vendor's documentation says the vendor answers, so what is asserted is the
 * request this product composes and the reading it takes of a reply — never
 * that Azure is up. The harness's substitutes at the port itself
 * (`fakeOcrProvider`, `refusingTranscriber` and the rest) are untouched and
 * still what every record test uses; this file is one level below them, and is
 * the only place the wire shape is written down twice.
 *
 * That is also the whole of what a test can say about an adapter. Whether the
 * vendor really accepts a `.docx`, and whether a recording made by a phone's
 * `MediaRecorder` really comes back as words, are facts about the vendor and
 * are checked on the deployed machine by hand — recorded in the ADRs, not
 * here.
 */

import { afterEach, expect, test } from 'vitest';
import {
  azureDocumentIntelligenceOcr,
  ocrProviderFromEnv,
  stubOcrProvider,
  unconfiguredOcrProvider,
} from '../src/ocr.js';
import {
  azureSpeechTranscriber,
  stubTranscriber,
  transcriberFromEnv,
  unconfiguredTranscriber,
} from '../src/transcription.js';
import {
  agentRunServiceFromEnv,
  failIfTheModelFailed,
  modelChoice,
  pinModel,
  unconfiguredAgentRunService,
} from '../src/agent.js';

const ENDPOINT = 'https://example-resource.cognitiveservices.azure.com';
const KEY = 'a-key-that-is-never-in-source';

const A_DOCUMENT = Buffer.from('%PDF-1.7 a drawing set');
const AN_AUDIO = Buffer.from('a recording made on a walk');

/**
 * The environment is process-wide, so every test that names a vendor puts back
 * what it found. Restored rather than deleted: a developer's own `OCR=stub`
 * must survive the suite.
 */
const environment: [string, string | undefined][] = [];

function setEnv(name: string, value: string | undefined) {
  environment.push([name, process.env[name]]);
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  for (const [name, value] of environment.splice(0).reverse()) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

/** One recorded call, in the order the adapter made it. */
interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
  /** The multipart parts, where the body was one. */
  form: FormData | undefined;
}

/**
 * A `fetch` that answers from a script and records what it was asked.
 *
 * The script is consumed in order and the last entry repeats, which is what
 * lets one entry stand for "the vendor is still running" however many times it
 * is polled.
 */
function scriptedFetch(script: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetcher = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
      form: init?.body instanceof FormData ? init.body : undefined,
    };
    calls.push(call);
    return script(call);
  };
  return Object.assign(fetcher as unknown as typeof globalThis.fetch, {
    calls,
  });
}

const RESULT =
  'https://example-resource.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-read/analyzeResults/a-result-id?api-version=2024-11-30';

function accepted() {
  return new Response(null, {
    status: 202,
    headers: { 'operation-location': RESULT },
  });
}

function analysis(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// --- the OCR adapter -------------------------------------------------------

test('the document goes to the Read model inline, and what the vendor read comes back', async () => {
  const fetcher = scriptedFetch((call) =>
    call.method === 'POST'
      ? accepted()
      : analysis({
          status: 'succeeded',
          analyzeResult: { content: 'RFI-001 — the baseplate detail' },
        }),
  );

  const provider = azureDocumentIntelligenceOcr({
    endpoint: ENDPOINT,
    key: KEY,
    fetch: fetcher,
    pollMs: 0,
  });

  expect(await provider.read(A_DOCUMENT, 'application/pdf', 'set.pdf')).toBe(
    'RFI-001 — the baseplate detail',
  );

  const [analyze] = fetcher.calls;
  expect(analyze!.method).toBe('POST');
  expect(analyze!.url).toBe(
    `${ENDPOINT}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=2024-11-30`,
  );
  expect(analyze!.headers.get('ocp-apim-subscription-key')).toBe(KEY);
  expect(analyze!.headers.get('content-type')).toBe('application/json');
  // The bytes themselves, inline: there is no object storage in this
  // deployment and the vendor was picked for being able to take them this way.
  expect(JSON.parse(analyze!.body!)).toEqual({
    base64Source: A_DOCUMENT.toString('base64'),
  });
});

test('the vendor is polled at the result it named until it finishes', async () => {
  let polls = 0;
  const fetcher = scriptedFetch((call) => {
    if (call.method !== 'GET') {
      // The delete that follows a read is not a poll, and counting it here is
      // what made this test wrong before the adapter was.
      return accepted();
    }
    polls += 1;
    return polls < 3
      ? analysis({ status: 'running' })
      : analysis({ status: 'succeeded', analyzeResult: { content: 'page' } });
  });

  const provider = azureDocumentIntelligenceOcr({
    endpoint: ENDPOINT,
    key: KEY,
    fetch: fetcher,
    pollMs: 0,
  });

  expect(await provider.read(A_DOCUMENT, 'application/pdf', 'set.pdf')).toBe(
    'page',
  );
  expect(polls).toBe(3);
  expect(fetcher.calls[1]!.url).toBe(RESULT);
  expect(fetcher.calls[1]!.headers.get('ocp-apim-subscription-key')).toBe(KEY);
});

test('the analyze result is deleted once it has been read', async () => {
  const fetcher = scriptedFetch((call) =>
    call.method === 'POST'
      ? accepted()
      : call.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : analysis({ status: 'succeeded', analyzeResult: { content: 'page' } }),
  );

  const provider = azureDocumentIntelligenceOcr({
    endpoint: ENDPOINT,
    key: KEY,
    fetch: fetcher,
    pollMs: 0,
  });
  await provider.read(A_DOCUMENT, 'application/pdf', 'set.pdf');

  // The 24-hour retention is the vendor's default; this is the call that does
  // not wait for it, and it is the control the vendor was picked for.
  const deletes = fetcher.calls.filter((call) => call.method === 'DELETE');
  expect(deletes).toHaveLength(1);
  expect(deletes[0]!.url).toBe(RESULT);
  expect(deletes[0]!.headers.get('ocp-apim-subscription-key')).toBe(KEY);
});

test('a delete the vendor refuses does not lose the text it already read', async () => {
  const fetcher = scriptedFetch((call) => {
    if (call.method === 'POST') {
      return accepted();
    }
    if (call.method === 'DELETE') {
      return new Response('no', { status: 500 });
    }
    return analysis({ status: 'succeeded', analyzeResult: { content: 'page' } });
  });

  const provider = azureDocumentIntelligenceOcr({
    endpoint: ENDPOINT,
    key: KEY,
    fetch: fetcher,
    pollMs: 0,
  });

  // The worker stores `ocr_text` before the agent is called (ADR-0043), so
  // throwing here would discard a read the vendor has already been paid for
  // and already holds — the opposite of what the delete is for.
  expect(await provider.read(A_DOCUMENT, 'application/pdf', 'set.pdf')).toBe(
    'page',
  );
});

test('a document the vendor refuses fails with the vendor status and never the document', async () => {
  const fetcher = scriptedFetch(() =>
    analysis(
      { error: { code: 'InvalidContent', message: 'unsupported media type' } },
      415,
    ),
  );

  const provider = azureDocumentIntelligenceOcr({
    endpoint: ENDPOINT,
    key: KEY,
    fetch: fetcher,
    pollMs: 0,
  });

  await expect(
    provider.read(A_DOCUMENT, 'application/acad', 'plan.dwg'),
  ).rejects.toThrow(/415/);
  // Whatever is stamped on the row is read by a person on a screen, so it
  // carries the vendor's complaint and neither the key nor the document.
  await expect(
    provider.read(A_DOCUMENT, 'application/acad', 'plan.dwg'),
  ).rejects.toThrow(/unsupported media type/);
  await expect(
    provider.read(A_DOCUMENT, 'application/acad', 'plan.dwg'),
  ).rejects.not.toThrow(new RegExp(KEY));
});

test('an analysis the vendor gave up on fails with the vendor own sentence', async () => {
  const fetcher = scriptedFetch((call) =>
    call.method === 'POST'
      ? accepted()
      : analysis({
          status: 'failed',
          error: { code: 'InvalidRequest', message: 'the file is password-locked' },
        }),
  );

  const provider = azureDocumentIntelligenceOcr({
    endpoint: ENDPOINT,
    key: KEY,
    fetch: fetcher,
    pollMs: 0,
  });

  await expect(
    provider.read(A_DOCUMENT, 'application/pdf', 'set.pdf'),
  ).rejects.toThrow(/password-locked/);
});

test('a vendor that accepts the document and names no result fails rather than hanging', async () => {
  const fetcher = scriptedFetch(() => new Response(null, { status: 202 }));

  const provider = azureDocumentIntelligenceOcr({
    endpoint: ENDPOINT,
    key: KEY,
    fetch: fetcher,
    pollMs: 0,
  });

  await expect(
    provider.read(A_DOCUMENT, 'application/pdf', 'set.pdf'),
  ).rejects.toThrow(/named no result/);
});

test('a vendor that never finishes is bounded by the wall clock', async () => {
  const fetcher = scriptedFetch((call) =>
    call.method === 'POST' ? accepted() : analysis({ status: 'running' }),
  );

  const provider = azureDocumentIntelligenceOcr({
    endpoint: ENDPOINT,
    key: KEY,
    fetch: fetcher,
    pollMs: 1,
    wallClockMs: 30,
  });

  // A held vendor call is a job that never ends and a record stuck at
  // *running* on the screen, which is the state the four stamps exist to make
  // visible. The bound turns it into a failure a person can retry.
  await expect(
    provider.read(A_DOCUMENT, 'application/pdf', 'set.pdf'),
  ).rejects.toThrow(/did not finish/);
});

test('a vendor that hangs on the delete does not hang the job', async () => {
  // The delete runs in a `finally` after the read, so an unbounded one would
  // add its own wait to a function whose whole promise is a bound — and the
  // read has already succeeded by then, so nothing else would ever stop it.
  const fetcher = ((_input: unknown, init?: RequestInit) => {
    if (init?.method === 'DELETE') {
      // Hangs, and settles only if something aborts it. `init.signal?` and not
      // `init.signal!`: with the bound removed there is no signal, and the
      // non-null assertion would throw a TypeError that `forget`'s catch
      // swallows — which made the first version of this test pass against the
      // very bug it was written for.
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    }
    return Promise.resolve(
      init?.method === 'POST'
        ? accepted()
        : analysis({ status: 'succeeded', analyzeResult: { content: 'page' } }),
    );
  }) as unknown as typeof globalThis.fetch;

  const provider = azureDocumentIntelligenceOcr({
    endpoint: ENDPOINT,
    key: KEY,
    fetch: fetcher,
    pollMs: 0,
  });

  // It resolves at all, and with the text the vendor already gave: the
  // delete's own bound expires and is swallowed. Without a signal on that
  // call this test does not return.
  expect(await provider.read(A_DOCUMENT, 'application/pdf', 'set.pdf')).toBe(
    'page',
  );
}, 20_000);

// --- the transcription adapter ---------------------------------------------

test('the recording goes up as its own bytes and the words come back', async () => {
  const fetcher = scriptedFetch(() =>
    analysis({
      combinedPhrases: [{ text: 'conduit is running below the slab' }],
    }),
  );

  const transcriber = azureSpeechTranscriber({
    endpoint: ENDPOINT,
    key: KEY,
    fetch: fetcher,
  });

  expect(await transcriber.transcribe(AN_AUDIO, 'audio/webm')).toBe(
    'conduit is running below the slab',
  );

  const [call] = fetcher.calls;
  expect(call!.method).toBe('POST');
  expect(call!.url).toBe(
    `${ENDPOINT}/speechtotext/transcriptions:transcribe?api-version=2025-10-15`,
  );
  expect(call!.headers.get('ocp-apim-subscription-key')).toBe(KEY);
});

test('the recording is one multipart part and the ask is another', async () => {
  const fetcher = scriptedFetch(() =>
    analysis({ combinedPhrases: [{ text: 'words' }] }),
  );

  const transcriber = azureSpeechTranscriber({
    endpoint: ENDPOINT,
    key: KEY,
    fetch: fetcher,
  });
  await transcriber.transcribe(AN_AUDIO, 'audio/webm');

  // The part names are the vendor's and nothing here can discover them: if
  // `audio` were `file` the adapter would fail in production and every other
  // test in this file would still pass. Asserted so the wire shape is written
  // down once rather than assumed twice.
  const form = fetcher.calls[0]!.form!;
  expect([...form.keys()].sort()).toEqual(['audio', 'definition']);
  expect(form.get('definition')).toBe(JSON.stringify({ locales: ['en-US'] }));

  const sent = form.get('audio') as File;
  expect(sent.type).toBe('audio/webm');
  // The port carries no filename and the vendor reads the extension as a hint
  // to its own demuxer, so it is composed from the content type — the mapping
  // `voice-form.tsx` already uses to name a recording.
  expect(sent.name).toBe('recording.webm');
  expect(Buffer.from(await sent.arrayBuffer())).toEqual(AN_AUDIO);
});

test('a content type outside the closed three is sent unnamed rather than mislabelled', async () => {
  const fetcher = scriptedFetch(() =>
    analysis({ combinedPhrases: [{ text: 'words' }] }),
  );

  const transcriber = azureSpeechTranscriber({
    endpoint: ENDPOINT,
    key: KEY,
    fetch: fetcher,
  });
  await transcriber.transcribe(AN_AUDIO, 'audio/flac');

  // Guessing an extension here would tell the vendor something false about
  // bytes it is about to demux; leaving it off leaves it to sniff.
  const sent = fetcher.calls[0]!.form!.get('audio') as File;
  expect(sent.name).toBe('recording');
  expect(sent.type).toBe('audio/flac');
});

test('every channel the vendor heard is kept, not the first', async () => {
  const fetcher = scriptedFetch(() =>
    analysis({
      combinedPhrases: [
        { text: 'the engineer speaking' },
        { text: 'the superintendent answering' },
      ],
    }),
  );

  const transcriber = azureSpeechTranscriber({
    endpoint: ENDPOINT,
    key: KEY,
    fetch: fetcher,
  });

  // The vendor returns one entry per channel. Keeping `[0]` would drop the
  // second speaker while the capture still read as transcribed — a rewrite by
  // omission, and an invisible one, which is what ADR-0034 forbids.
  expect(await transcriber.transcribe(AN_AUDIO, 'audio/webm')).toBe(
    'the engineer speaking\nthe superintendent answering',
  );
});

test('a recording the vendor heard nothing in transcribes to nothing, and does not fail', async () => {
  const fetcher = scriptedFetch(() => analysis({ combinedPhrases: [] }));

  const transcriber = azureSpeechTranscriber({
    endpoint: ENDPOINT,
    key: KEY,
    fetch: fetcher,
  });

  // Silence is a thing a walk records, and it is not a vendor failure: the
  // capture reads as transcribed with nothing in it, and the engineer types
  // what they meant to say. A rejection here would stamp `failed_at` on a
  // recording the vendor answered perfectly well.
  expect(await transcriber.transcribe(AN_AUDIO, 'audio/webm')).toBe('');
});

test('a recording the vendor refuses fails with its status and never the key', async () => {
  const fetcher = scriptedFetch(
    () => new Response('unsupported audio format', { status: 400 }),
  );

  const transcriber = azureSpeechTranscriber({
    endpoint: ENDPOINT,
    key: KEY,
    fetch: fetcher,
  });

  await expect(transcriber.transcribe(AN_AUDIO, 'audio/ogg')).rejects.toThrow(
    /400/,
  );
  await expect(transcriber.transcribe(AN_AUDIO, 'audio/ogg')).rejects.toThrow(
    /unsupported audio format/,
  );
  await expect(
    transcriber.transcribe(AN_AUDIO, 'audio/ogg'),
  ).rejects.not.toThrow(new RegExp(KEY));
});

test('a vendor that never answers is bounded by the wall clock', async () => {
  // A held call and not a thrown one: a real `fetch` rejects with the signal's
  // own reason when the bound expires, so the adapter has to recognise that
  // rather than the vendor having the courtesy to refuse.
  const fetcher = ((_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener(
        'abort',
        () => reject(init!.signal!.reason),
        { once: true },
      );
    })) as unknown as typeof globalThis.fetch;

  const transcriber = azureSpeechTranscriber({
    endpoint: ENDPOINT,
    key: KEY,
    fetch: fetcher,
    wallClockMs: 10,
  });

  await expect(transcriber.transcribe(AN_AUDIO, 'audio/webm')).rejects.toThrow(
    /did not answer/,
  );
});

// --- what a deployment selects ---------------------------------------------

test('a deployment that configures nothing still refuses, with the port sentence', () => {
  setEnv('OCR', undefined);
  setEnv('TRANSCRIBER', undefined);

  expect(ocrProviderFromEnv()).toBe(unconfiguredOcrProvider);
  expect(transcriberFromEnv()).toBe(unconfiguredTranscriber);
});

test('an unrecognised vendor name is the refusing default and never a guess', () => {
  setEnv('OCR', 'textract');
  setEnv('TRANSCRIBER', 'whisper');

  expect(ocrProviderFromEnv()).toBe(unconfiguredOcrProvider);
  expect(transcriberFromEnv()).toBe(unconfiguredTranscriber);
});

test('the stubs are still off by default and still reachable by name', () => {
  setEnv('OCR', 'stub');
  setEnv('TRANSCRIBER', 'stub');

  expect(ocrProviderFromEnv()).toBe(stubOcrProvider);
  expect(transcriberFromEnv()).toBe(stubTranscriber);
});

test('naming a vendor builds its adapter', () => {
  setEnv('OCR', 'azure');
  setEnv('AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT', ENDPOINT);
  setEnv('AZURE_DOCUMENT_INTELLIGENCE_KEY', KEY);
  setEnv('TRANSCRIBER', 'azure');
  setEnv('AZURE_SPEECH_ENDPOINT', ENDPOINT);
  setEnv('AZURE_SPEECH_KEY', KEY);

  expect(ocrProviderFromEnv()).not.toBe(unconfiguredOcrProvider);
  expect(transcriberFromEnv()).not.toBe(unconfiguredTranscriber);
});

test('a vendor named without its credential takes the process down at startup', () => {
  setEnv('OCR', 'azure');
  setEnv('AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT', ENDPOINT);
  setEnv('AZURE_DOCUMENT_INTELLIGENCE_KEY', undefined);
  setEnv('TRANSCRIBER', 'azure');
  setEnv('AZURE_SPEECH_ENDPOINT', ENDPOINT);
  setEnv('AZURE_SPEECH_KEY', undefined);

  // `index.ts` calls both of these while it is still wiring, so this throw is
  // a deployment that does not boot rather than one that boots and fails a
  // record at a time with a sentence about a vendor.
  expect(() => ocrProviderFromEnv()).toThrow(
    /AZURE_DOCUMENT_INTELLIGENCE_KEY is not set/,
  );
  expect(() => transcriberFromEnv()).toThrow(/AZURE_SPEECH_KEY is not set/);
});

// --- which model the agent runs (issue #157, ADR-0065) ----------------------

/** What `index.ts` hands the agent adapter; nothing here reaches either. */
const AGENT_OPTIONS = { apiBaseUrl: 'http://127.0.0.1:1', workspaceRoot: '.agent-workspaces' };

test('no agent named is still the refusing default, whatever model is named', () => {
  setEnv('AGENT', undefined);
  setEnv('AGENT_MODEL', 'alibaba-plan/deepseek-v4.1-flash');

  expect(agentRunServiceFromEnv(AGENT_OPTIONS)).toBe(unconfiguredAgentRunService);
});

test('an agent named without a model takes the process down at startup', () => {
  // Left to the SDK, the model is whichever credentialed provider comes first
  // in its own table — which is how the machine ran a model nobody chose.
  setEnv('AGENT', 'pi');
  setEnv('AGENT_MODEL', undefined);

  expect(() => agentRunServiceFromEnv(AGENT_OPTIONS)).toThrow(/AGENT_MODEL is not set/);
});

test('a model named without its provider takes the process down at startup', () => {
  setEnv('AGENT', 'pi');

  for (const malformed of ['deepseek-v4.1-flash', '/deepseek-v4.1-flash', 'alibaba-plan/']) {
    setEnv('AGENT_MODEL', malformed);
    expect(() => agentRunServiceFromEnv(AGENT_OPTIONS)).toThrow(
      `AGENT_MODEL must be <provider>/<model>, got ${malformed}`,
    );
  }
});

test('naming the agent and its model builds the adapter', () => {
  setEnv('AGENT', 'pi');
  setEnv('AGENT_MODEL', 'alibaba-plan/deepseek-v4.1-flash');

  expect(agentRunServiceFromEnv(AGENT_OPTIONS)).not.toBe(unconfiguredAgentRunService);
});

test('a model id may carry its own slash; the provider is everything before the first', () => {
  expect(modelChoice('alibaba-plan/deepseek-v4.1-flash')).toEqual({
    provider: 'alibaba-plan',
    id: 'deepseek-v4.1-flash',
  });
  expect(modelChoice('openrouter/deepseek/deepseek-chat')).toEqual({
    provider: 'openrouter',
    id: 'deepseek/deepseek-chat',
  });
});

test('a run is moved onto the model that was named, and refuses one the deployment does not have', async () => {
  // The SDK is never loaded by a test (ADR-0040), so the two objects a run
  // pins through are stood in for by their shapes. Whether the real ones do
  // this on the machine was read there, and is recorded in ADR-0065.
  const available = { provider: 'alibaba-plan', id: 'deepseek-v4.1-flash' };
  const runtime = {
    getModel: (provider: string, id: string) =>
      provider === available.provider && id === available.id ? available : undefined,
  };
  const set: unknown[] = [];
  const session = {
    setModel: async (model: typeof available) => {
      set.push(model);
    },
  };

  await pinModel(runtime, session, modelChoice('alibaba-plan/deepseek-v4.1-flash'));
  expect(set).toEqual([available]);

  // Never a fallback: a run on a model nobody named is the defect.
  await expect(
    pinModel(runtime, session, modelChoice('alibaba-plan/no-such-model')),
  ).rejects.toThrow('the model alibaba-plan/no-such-model is not available to this deployment');
  expect(set).toEqual([available]);
});

test('a provider error fails the run with the provider’s sentence, and a clean stop does not (issue #162)', () => {
  // What the SDK leaves behind, in shape: it does not throw on a provider
  // error, it appends an assistant message that stopped on `error` and
  // returns — so a run read *finished, proposed nothing*. This sentence is
  // the one `alibaba-plan/deepseek-v4.1-flash` answered on 2026-09-23.
  const refused =
    '400 data: {"error":{"code":"invalid_parameter_error","message":"developer is not one of [\'system\', \'assistant\', \'user\', \'tool\', \'function\']"}}';
  const asked = { role: 'user' };
  const TOOL = 'assumption_record_propose';

  expect(() =>
    failIfTheModelFailed(TOOL, [asked, { role: 'assistant', stopReason: 'error', errorMessage: refused }]),
  ).toThrow(refused);
  expect(() =>
    failIfTheModelFailed(TOOL, [asked, { role: 'assistant', stopReason: 'aborted' }]),
  ).toThrow('the model provider stopped the run: aborted');

  // An answer, and an answer after a tool call, are both a run that finished.
  expect(() =>
    failIfTheModelFailed(TOOL, [asked, { role: 'assistant', stopReason: 'stop' }]),
  ).not.toThrow();
  expect(() =>
    failIfTheModelFailed(TOOL, [
      asked,
      { role: 'assistant', stopReason: 'toolUse' },
      { role: 'toolResult' },
      { role: 'assistant', stopReason: 'stop' },
    ]),
  ).not.toThrow();

  // Only the **last** answer counts: an error the SDK retried past is not the
  // outcome of the run.
  expect(() =>
    failIfTheModelFailed(TOOL, [
      asked,
      { role: 'assistant', stopReason: 'error', errorMessage: refused },
      { role: 'assistant', stopReason: 'stop' },
    ]),
  ).not.toThrow();

  // A run's job is its proposal. Once the route took it, a provider error on
  // the model's wrap-up turn is not the run failing: the proposal is on the
  // record and reviewable, and *failed* beside it would send the engineer to
  // ask again for something they already have.
  const answered = (status: number) => ({
    role: 'toolResult',
    toolName: TOOL,
    isError: false,
    content: [{ type: 'text', text: JSON.stringify({ status, body: {} }) }],
  });
  const afterwards = { role: 'assistant', stopReason: 'error', errorMessage: refused };
  expect(() =>
    failIfTheModelFailed(TOOL, [asked, { role: 'assistant', stopReason: 'toolUse' }, answered(201), afterwards]),
  ).not.toThrow();

  // A proposal the route **refused** is not one that landed, and neither is
  // another tool's success or a tool that threw.
  expect(() =>
    failIfTheModelFailed(TOOL, [asked, answered(409), afterwards]),
  ).toThrow(refused);
  expect(() =>
    failIfTheModelFailed(TOOL, [asked, { ...answered(201), toolName: 'projects_get' }, afterwards]),
  ).toThrow(refused);
  expect(() =>
    failIfTheModelFailed(TOOL, [asked, { ...answered(201), isError: true }, afterwards]),
  ).toThrow(refused);
});
