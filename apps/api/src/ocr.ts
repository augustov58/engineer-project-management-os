import { requireEnv } from './env.js';
import { complaint, isAbort } from './vendor.js';

/**
 * What a document says, as text, injectable at the worker the way
 * `Transcriber` is (ADR-0034's shape) — the first step of extraction
 * (issue #20, ADR-0043): bytes in, words out, and the extraction pass itself
 * is the agent's.
 *
 * **An adapter is written since issue #109, and what that changed is recorded
 * rather than glossed.** For four narrowings of the employer-consent gate the
 * load-bearing fact here was that no adapter existed: until somebody wrote
 * one, no document's content left this process — not to an OCR API, and not to
 * the model provider either, because the worker calls the agent only with the
 * text this port returned. That sentence is now spent. The gate is no longer
 * "no adapter exists" but "the default still refuses, and a deployment that
 * names a vendor has said so out loud" — `unconfiguredOcrProvider` is still
 * what `ocrProviderFromEnv` falls through to, and naming a vendor is a
 * deliberate act with a credential attached.
 *
 * The two gates in front of this port are unchanged and are what actually
 * bound it: both extraction create routes refuse the ask on a project set to
 * `LOCAL`, and the worker reads the setting again before the bytes are
 * fetched (ADR-0044). Tests substitute a fake at the port, which is the seam
 * the plan names for every vendor the system leaves the process for.
 *
 * One method, taking bytes and what the sender claimed they are, and
 * answering with text. It does not report a percentage, for `Transcriber`'s
 * reason: what the engineer sees moving is the extraction's state, which is a
 * fact the product actually holds.
 */
export interface OcrProvider {
  read(document: Buffer, contentType: string, filename: string): Promise<string>;
}

/**
 * The default: there is no vendor, and it says so.
 *
 * The honest adapter for a deployment that has named none, and
 * `unconfiguredTranscriber`'s posture exactly: every extraction asked for
 * reads as failed with this sentence, the source is exactly where it was, and
 * nothing left the process. Still the fallthrough after issue #109, which is
 * the whole of what keeps the gate meaningful now an adapter exists.
 */
export const unconfiguredOcrProvider: OcrProvider = {
  read: () => Promise.reject(new Error('no OCR provider is configured')),
};

/**
 * A fixed page of text, for exercising the extraction screens without a
 * vendor.
 *
 * Off unless `OCR=stub`, and it never runs on a real document: it returns the
 * same page whatever it is given, and the page says so. It exists because the
 * proposal is reviewed and corrected before it commits, so the screen that
 * does the correcting has to be reachable — and it stays after issue #109 for
 * the reason it arrived: a screen should be exercisable without spending a
 * vendor's page count or sending anything anywhere.
 */
export const stubOcrProvider: OcrProvider = {
  read: () =>
    Promise.resolve(
      [
        '[stub OCR — no vendor is configured, so this page is invented]',
        'RFI-001 — Clarification of the baseplate detail',
        'From: Acme Mechanical',
        'To: the engineer',
        'Question: which baseplate detail governs at Grid C4?',
      ].join('\n'),
    ),
};

/**
 * The Azure AI Document Intelligence model this product asks for, and the API
 * version every one of its calls must carry.
 *
 * `prebuilt-read` is the OCR model and the cheapest of them — $1.50 per 1,000
 * page units against `prebuilt-layout`'s $10.00 — and it is what ADR-0008
 * asked for: the text of the document, with the fields extracted from that
 * text by the agent and never by the vendor. The api-version is a **required**
 * query parameter on analyze, poll and delete alike; it is not defaulted
 * server-side. The path segment is `documentintelligence` and not the v3
 * `formrecognizer`, which is a different and retiring surface.
 */
const READ_MODEL = 'prebuilt-read';
const OCR_API_VERSION = '2024-11-30';

/**
 * How long one document may take, poll included.
 *
 * Five minutes because the vendor's own bound is 2,000 pages and a scanned
 * large-format set is the case that reaches for it, and because the thing this
 * number prevents is worse than a slow read: the worker awaits this call, so a
 * vendor that never answers is a job that never ends and a record stuck at
 * *running* on a screen whose whole job is to say what state a thing is in.
 * `helpers.ts` bounds its subprocess at ten seconds for the same reason and a
 * different order of magnitude — that one is arithmetic, this one is a
 * document over a network.
 */
const OCR_WALL_CLOCK_MS = 300_000;

/**
 * How long the delete may take, separately from the read.
 *
 * Ten seconds, because it carries no document and reads no result — it is one
 * round trip saying *forget this* — and because it runs after the read has
 * either finished or run out of time, so it must not be able to add another
 * five minutes to a job that has already spent them.
 */
const FORGET_WALL_CLOCK_MS = 10_000;

/**
 * How long to wait between polls when the vendor names nothing itself.
 *
 * The vendor asks for no more than one poll every two seconds and answers with
 * `Retry-After` when it has an opinion; this is the floor for when it does
 * not.
 */
const OCR_POLL_MS = 2_000;

/** A `Retry-After` is honoured, but never past this — the bound is ours. */
const MAX_POLL_MS = 30_000;

/**
 * How long to wait before asking again: the vendor's opinion where it has one,
 * ours where it does not, and never longer than `MAX_POLL_MS`.
 *
 * Clamped because `Retry-After` is a value the far side chooses, and an hour of
 * it would hold a worker slot for an hour inside a wall clock that was supposed
 * to bound exactly that. Only the delta-seconds form is read; the HTTP-date
 * form falls to the floor below, which is a slower poll and never a wrong one.
 *
 * Here and not in `vendor.ts` because it has exactly one reader — the
 * transcription adapter answers in a single call and never polls — and
 * ADR-0033's trigger is a *second* record reaching for a thing, not the
 * expectation that one might.
 */
function retryDelayMs(response: Response, floorMs: number): number {
  const after = Number(response.headers.get('retry-after'));
  return Number.isFinite(after) && after > 0
    ? Math.min(after * 1000, MAX_POLL_MS)
    : floorMs;
}

/**
 * Wait, and stop waiting early if the wall clock runs out.
 *
 * Not `setTimeout` alone: a poll floor of thirty seconds inside a bound that
 * has already expired is thirty seconds of a worker doing nothing before it
 * reads the signal that was set before it started sleeping. An already-aborted
 * signal is checked rather than listened for, because `abort` does not fire
 * again on a signal that has already fired.
 */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** What a deployment must supply to reach Azure AI Document Intelligence. */
export interface AzureOcrOptions {
  /** The resource, e.g. `https://<name>.cognitiveservices.azure.com`. */
  endpoint: string;
  /** The resource key. An environment string, never a file and never source. */
  key: string;
  /**
   * The seam every test here substitutes at. Defaults to the platform's, so
   * production composes nothing of its own.
   */
  fetch?: typeof globalThis.fetch;
  wallClockMs?: number;
  pollMs?: number;
}

/** The shape of a poll, narrowed to the two things this product reads. */
interface AnalyzeOperation {
  status?: string;
  error?: { message?: string };
  analyzeResult?: { content?: string };
}

/**
 * Azure AI Document Intelligence, `prebuilt-read` (issue #109, ADR-0060).
 *
 * Three calls and no SDK. The bytes go up **inline** as `base64Source`, which
 * is why this vendor was picked over the two the vault had been weighing since
 * 2026-08-24: there is no object storage in this deployment and both Textract
 * and Google Document AI reach for one past the first page. The vendor answers
 * 202 and names a result; the result is polled until it settles; and then it
 * is **deleted**, which is the one control of the three that the consent
 * conversation can actually be shown — without it the document sits at the
 * vendor for 24 hours.
 *
 * A hand-written adapter rather than `@azure-rest/ai-document-intelligence`
 * deliberately: three calls is less code than the SDK's poller costs to
 * substitute, and the seam a test needs here is `fetch` itself. The dependency
 * is not added, and no test calls the vendor.
 */
export function azureDocumentIntelligenceOcr(
  options: AzureOcrOptions,
): OcrProvider {
  const call = options.fetch ?? globalThis.fetch;
  const wallClockMs = options.wallClockMs ?? OCR_WALL_CLOCK_MS;
  const pollMs = options.pollMs ?? OCR_POLL_MS;
  const endpoint = options.endpoint.replace(/\/+$/, '');
  const identifying = { 'ocp-apim-subscription-key': options.key };

  const analyzeUrl = `${endpoint}/documentintelligence/documentModels/${READ_MODEL}:analyze?api-version=${OCR_API_VERSION}`;

  /**
   * What the row says when the bound was reached rather than the vendor
   * answering.
   *
   * One sentence with two callers — the loop notices a spent clock between
   * polls, and the `catch` notices a `fetch` the platform aborted mid-flight —
   * and it is a sentence a person reads off a screen, so the two must not be
   * free to drift apart.
   */
  const ranOut = () => `the OCR vendor did not finish within ${wallClockMs} ms`;

  /**
   * The result is read, and then forgotten at the vendor whatever happened.
   *
   * Never allowed to throw: the worker stores `ocr_text` before it calls the
   * agent precisely so a later failure keeps what the vendor read, and a
   * delete the vendor refused would otherwise throw that away — a failure to
   * clean up turned into a failure to extract. What it costs when it does fail
   * is the vendor's own 24-hour expiry, which is where the document would have
   * sat anyway.
   *
   * **Its own bound, and deliberately not the read's.** This runs in a
   * `finally`, so the commonest reason to reach it with the read's wall clock
   * already expired is that the wall clock expired — and that is exactly the
   * case where the document is still sitting at the vendor and most wants
   * deleting. Handing it the spent signal would skip the delete precisely
   * then. Handing it no signal at all is what the first version did, and that
   * is worse in the other direction: an unbounded call inside a function whose
   * whole promise is a bound, so a vendor that stopped answering turned five
   * minutes into however long the platform's own default is.
   */
  const forget = async (result: string) => {
    try {
      await call(result, {
        method: 'DELETE',
        headers: identifying,
        signal: AbortSignal.timeout(FORGET_WALL_CLOCK_MS),
      });
    } catch {
      // Nothing: see above.
    }
  };

  const settle = async (result: string, timeout: AbortSignal) => {
    for (;;) {
      const response = await call(result, {
        headers: identifying,
        signal: timeout,
      });
      if (!response.ok) {
        throw new Error(
          `the OCR vendor would not say what it read (${response.status}): ${await complaint(response)}`,
        );
      }
      const body = (await response.json()) as AnalyzeOperation;
      if (body.status === 'succeeded') {
        // An empty document really does read as nothing, and that is a fact
        // about the document rather than a failure of the vendor.
        return body.analyzeResult?.content ?? '';
      }
      if (body.status === 'failed' || body.status === 'canceled') {
        throw new Error(
          `the OCR vendor could not read the document: ${body.error?.message ?? body.status}`,
        );
      }
      if (timeout.aborted) {
        throw new Error(ranOut());
      }
      await pause(retryDelayMs(response, pollMs), timeout);
    }
  };

  return {
    read: async (document) => {
      const timeout = AbortSignal.timeout(wallClockMs);
      try {
        const analyze = await call(analyzeUrl, {
          method: 'POST',
          headers: { ...identifying, 'content-type': 'application/json' },
          body: JSON.stringify({ base64Source: document.toString('base64') }),
          signal: timeout,
        });
        if (analyze.status !== 202) {
          throw new Error(
            `the OCR vendor refused the document (${analyze.status}): ${await complaint(analyze)}`,
          );
        }
        const result = analyze.headers.get('operation-location');
        if (result === null) {
          throw new Error(
            'the OCR vendor accepted the document and named no result to read',
          );
        }
        try {
          return await settle(result, timeout);
        } finally {
          await forget(result);
        }
      } catch (error) {
        // A real `fetch` rejects with an abort rather than returning, so the
        // bound has to be said here as well as inside the loop, or a held
        // vendor call reads on the row as the platform's own word for it.
        if (timeout.aborted && isAbort(error)) {
          throw new Error(ranOut());
        }
        throw error;
      }
    },
  };
}

/**
 * The adapter this deployment runs. Read once, at the boundary, so nothing
 * below here asks an environment variable what it is talking to.
 *
 * The default is `unconfiguredOcrProvider` and an unrecognised name falls
 * through to it as well, which is the one thing in this function that is load
 * bearing: a deployment that misspells its vendor must refuse rather than pick
 * something. The credential is read **only** when the vendor is named, so a
 * deployment on the default still boots with nothing configured; when it is
 * named, `requireEnv` throws while `index.ts` is still wiring, which is a
 * machine that does not start rather than one that fails a record at a time.
 */
export function ocrProviderFromEnv(): OcrProvider {
  switch (process.env['OCR']) {
    case 'azure':
      return azureDocumentIntelligenceOcr({
        endpoint: requireEnv('AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT'),
        key: requireEnv('AZURE_DOCUMENT_INTELLIGENCE_KEY'),
      });
    case 'stub':
      return stubOcrProvider;
    default:
      return unconfiguredOcrProvider;
  }
}

