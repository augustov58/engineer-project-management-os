/**
 * What a document says, as text, injectable at the worker the way
 * `Transcriber` is (ADR-0034's shape) — the first step of extraction
 * (issue #20, ADR-0043): bytes in, words out, and the extraction pass itself
 * is the agent's.
 *
 * The vendor is an open pick — Textract vs Google Document AI has been on the
 * vault's open-vendor list since 2026-08-24 — so the port is what the product
 * depends on and the adapter is what deployment chooses. **No adapter is
 * written, and that is load-bearing**: it is what keeps the employer-consent
 * gate, the same move ADR-0042 made for the inbound mail provider. Until
 * somebody writes one, no document's content leaves this process — not to an
 * OCR API, and not to the model provider either, because the worker calls the
 * agent only with the text this port returned. Tests substitute a fake, which
 * is the seam the plan names for every vendor the system leaves the process
 * for.
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
 * The honest adapter for the state the pick is actually in, and
 * `unconfiguredTranscriber`'s posture exactly: every extraction asked for
 * reads as failed with this sentence, the source is exactly where it was, and
 * nothing left the process — which is the gate, exercised by the dev default
 * rather than only by a test.
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
 * does the correcting has to be reachable — and until a vendor is picked this
 * is the only thing that makes it reachable at all. The page reads as the
 * correspondence it stands in for, so the stub agent run's proposal has
 * something shaped like an RFI to land on.
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
 * The adapter this deployment runs. Read once, at the boundary, so nothing
 * below here asks an environment variable what it is talking to.
 */
export function ocrProviderFromEnv(): OcrProvider {
  return process.env['OCR'] === 'stub' ? stubOcrProvider : unconfiguredOcrProvider;
}
