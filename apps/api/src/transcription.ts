import { requireEnv } from './env.js';
import { complaint, isAbort } from './vendor.js';

/**
 * What was said in a recording, injectable at the API boundary the way
 * `TimeSource` and `ObjectStore` are (ADR-0022's shape).
 *
 * **An adapter is written since issue #109.** The vendor was on the vault's
 * open-vendor list from 2026-08-24 until then, and for that whole time the
 * default refusing was the only thing voice capture did in production: issue
 * #85 recorded it as structurally broken wherever it was deployed. What
 * replaced "no adapter exists" is the same posture the OCR port took —
 * `unconfiguredTranscriber` is still the fallthrough, and naming a vendor is a
 * deliberate act with a credential attached.
 *
 * Tests substitute a fake, which is the seam the plan names for every vendor
 * the system leaves the process for.
 *
 * One method, taking bytes and their type and answering with words. It does
 * **not** report a percentage: no vendor's progress figure means the same
 * thing as another's, and a number invented here would be a lie on a screen
 * whose whole job is to say that something slow is still working. What the
 * engineer sees moving is the state — queued, transcribing, transcribed —
 * which is a fact the product actually holds.
 */
export interface Transcriber {
  transcribe(audio: Buffer, contentType: string): Promise<string>;
}

/**
 * The default: there is no vendor, and it says so.
 *
 * The honest adapter for a deployment that has named none, and the same
 * position `ObjectStore` was in at slice 10 — except that a filesystem is a
 * real place to put bytes and there is no offline stand-in for understanding
 * speech. So the default refuses, every capture reads as failed with this
 * sentence, and the audio stays exactly where it is: which is the ticket's
 * own last criterion, exercised by the dev default rather than only by a test.
 */
export const unconfiguredTranscriber: Transcriber = {
  transcribe: () =>
    Promise.reject(new Error('no transcription vendor is configured')),
};

/**
 * A fixed line of text, for exercising the review screen without a vendor.
 *
 * Off unless `TRANSCRIBER=stub`, and it never runs on a real walk: it returns
 * the same sentence whatever it is given, and the sentence says so. It exists
 * because the draft is reviewed and corrected before it commits, so the screen
 * that does the correcting has to be reachable — and it stays after issue #109
 * for the reason it arrived: a screen should be exercisable without spending a
 * vendor's minutes or sending a recording anywhere.
 */
export const stubTranscriber: Transcriber = {
  transcribe: () =>
    Promise.resolve(
      '[stub transcription — no vendor is configured, so type what you said]',
    ),
};

/**
 * The Azure AI Speech operation this product asks for, and its API version.
 *
 * **Fast transcription and deliberately not batch.** Batch is the Azure Speech
 * API the vault would have been right to rule out: it reads audio from a blob
 * URL, and there is no object storage in this deployment. Fast transcription
 * is a different endpoint that takes the bytes in the request as
 * `multipart/form-data` and answers with the words in the same response — no
 * job, no polling, no stored artefact — which is what makes it fit a port
 * whose whole surface is one method that returns a string.
 */
const SPEECH_API_VERSION = '2025-10-15';

/**
 * How long one recording may take.
 *
 * Two minutes against the OCR adapter's five, and the difference is the point:
 * this call is synchronous, so the number bounds a vendor that has stopped
 * answering rather than one that is working through two thousand pages. A walk
 * records minutes of audio, not hours, and a capture that fails here keeps its
 * bytes in the store and can be asked again — or committed by hand, which is
 * the third thing "leaves the audio recoverable" is made of.
 */
const SPEECH_WALL_CLOCK_MS = 120_000;

/**
 * What the vendor is told the recording is called.
 *
 * The port carries the content type and not a filename, and the vendor reads
 * the part's filename as a hint to its own demuxer. The three are the closed
 * set `routes/voice.ts` admits and the same mapping `voice-form.tsx` uses to
 * name a recording; anything outside it keeps the type and gets no extension,
 * which leaves the vendor to sniff rather than be told something false.
 */
const AUDIO_EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
};

/** What a deployment must supply to reach Azure AI Speech. */
export interface AzureSpeechOptions {
  /** The resource, e.g. `https://<name>.cognitiveservices.azure.com`. */
  endpoint: string;
  /** The resource key. An environment string, never a file and never source. */
  key: string;
  /**
   * What the vendor is told to listen for. One locale and not a guess: the
   * vendor will detect among several if asked, and a walk in this firm is in
   * English, so the honest default is to say so rather than pay for detection.
   */
  locales?: string[];
  /**
   * The seam every test here substitutes at. Defaults to the platform's, so
   * production composes nothing of its own.
   */
  fetch?: typeof globalThis.fetch;
  wallClockMs?: number;
}

/** The shape of an answer, narrowed to the one thing this product reads. */
interface FastTranscription {
  combinedPhrases?: { text?: string }[];
}

/**
 * Azure AI Speech fast transcription (issue #109, ADR-0061).
 *
 * One call. The audio goes up as its own bytes in a multipart body and the
 * words come back in the same response, so nothing about a job's state has to
 * live anywhere — which is why this endpoint fits and why batch does not.
 *
 * The reason it was picked over a vendor with a better delete story is that it
 * has nothing to delete: Microsoft's data-privacy note for Speech names fast
 * transcription among the paths where "Microsoft does not retain or store the
 * data provided by customers", under a heading reading *No data trace*. For a
 * recording made on somebody else's site, which catches whatever was being
 * said nearby and not only what the engineer meant to record, never written
 * down is a better answer than written down and then deleted on request —
 * there is no window, no missed call and no orphan. **That is a statement in
 * documentation and not in the DPA**, which is the honest weakness of the pick
 * and is recorded as such in ADR-0061.
 */
export function azureSpeechTranscriber(
  options: AzureSpeechOptions,
): Transcriber {
  const call = options.fetch ?? globalThis.fetch;
  const wallClockMs = options.wallClockMs ?? SPEECH_WALL_CLOCK_MS;
  const locales = options.locales ?? ['en-US'];
  const endpoint = options.endpoint.replace(/\/+$/, '');
  const url = `${endpoint}/speechtotext/transcriptions:transcribe?api-version=${SPEECH_API_VERSION}`;

  return {
    transcribe: async (audio, contentType) => {
      const timeout = AbortSignal.timeout(wallClockMs);
      const extension = AUDIO_EXTENSIONS[contentType];
      const body = new FormData();
      body.append(
        'audio',
        new Blob([new Uint8Array(audio)], { type: contentType }),
        extension === undefined ? 'recording' : `recording.${extension}`,
      );
      // A string part and not a second file: the vendor reads it as JSON and
      // this is the whole of what this product asks it for. No diarization, no
      // timestamps and no channel split — nothing parses a transcript here
      // (ADR-0034), so anything richer than words would be a field nobody reads.
      body.append('definition', JSON.stringify({ locales }));

      try {
        // No `content-type` header: `fetch` writes it from the FormData, and
        // one set by hand would be missing the multipart boundary.
        const response = await call(url, {
          method: 'POST',
          headers: { 'ocp-apim-subscription-key': options.key },
          body,
          signal: timeout,
        });
        if (!response.ok) {
          throw new Error(
            `the transcription vendor refused the recording (${response.status}): ${await complaint(response)}`,
          );
        }
        const heard = (await response.json()) as FastTranscription;
        // **Every entry, not the first.** The vendor returns one
        // `combinedPhrases` entry per channel, so taking `[0]` drops a
        // channel's words from a stereo recording while the capture still
        // reads as *transcribed* — a rewrite by omission, which is the one
        // thing ADR-0034 says a transcript may never suffer. The two ways to
        // be wrong here are not symmetrical: a channel joined twice is
        // duplicated text the engineer reads on the review screen and deletes,
        // and a channel dropped is words nobody ever learns were said.
        //
        // Silence is a thing a walk records and is not a failure either: the
        // capture reads as transcribed with nothing in it and the engineer
        // types what they meant to say. Stamping `failed_at` here would hide a
        // recording the vendor answered perfectly well.
        return (heard.combinedPhrases ?? [])
          .map((phrase) => phrase.text ?? '')
          .filter((text) => text !== '')
          .join('\n');
      } catch (error) {
        if (timeout.aborted && isAbort(error)) {
          throw new Error(
            `the transcription vendor did not answer within ${wallClockMs} ms`,
          );
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
 * The default is `unconfiguredTranscriber` and an unrecognised name falls
 * through to it as well, which is the one thing in this function that is load
 * bearing: a deployment that misspells its vendor must refuse rather than pick
 * something. The credential is read **only** when the vendor is named, so a
 * deployment on the default still boots with nothing configured; when it is
 * named, `requireEnv` throws while `index.ts` is still wiring, which is a
 * machine that does not start rather than one that fails a walk at a time.
 */
export function transcriberFromEnv(): Transcriber {
  switch (process.env['TRANSCRIBER']) {
    case 'azure':
      return azureSpeechTranscriber({
        endpoint: requireEnv('AZURE_SPEECH_ENDPOINT'),
        key: requireEnv('AZURE_SPEECH_KEY'),
      });
    case 'stub':
      return stubTranscriber;
    default:
      return unconfiguredTranscriber;
  }
}
