/**
 * What was said in a recording, injectable at the API boundary the way
 * `TimeSource` and `ObjectStore` are (ADR-0022's shape).
 *
 * The vendor is an open pick — it is on the vault's open-vendor list and has
 * been since 2026-08-24 — so the port is what the product depends on and the
 * adapter is what deployment chooses. Tests substitute a fake, which is the
 * seam the plan names for every vendor the system leaves the process for.
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
 * The honest adapter for the state the pick is actually in, and the same
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
 * that does the correcting has to be reachable — and until a vendor is picked
 * this is the only thing that makes it reachable at all.
 */
export const stubTranscriber: Transcriber = {
  transcribe: () =>
    Promise.resolve(
      '[stub transcription — no vendor is configured, so type what you said]',
    ),
};

/**
 * The adapter this deployment runs. Read once, at the boundary, so nothing
 * below here asks an environment variable what it is talking to.
 */
export function transcriberFromEnv(): Transcriber {
  return process.env['TRANSCRIBER'] === 'stub'
    ? stubTranscriber
    : unconfiguredTranscriber;
}
