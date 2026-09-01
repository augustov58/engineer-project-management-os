/**
 * The inbound mail provider, behind a port with **no adapter written**
 * (issue #19, ADR-0042).
 *
 * This is ADR-0034's posture toward the transcription vendor, arriving for a
 * second vendor and for a second reason. There it deferred a pick nobody had
 * made. Here it does that *and* it is what keeps the employer-consent gate:
 * an inbound-parse provider would hold the whole of every forwarded message —
 * the covering note, the thread beneath it and every file on it — which is a
 * stronger consent case than the OCR API ADR-0008 and ADR-0013 scope the
 * confidentiality trade-off to, and one nobody has yet been asked about.
 *
 * With no adapter, nothing leaves this process and no message reaches a third
 * party. The gate fires on writing one and naming the vendor.
 */

/** One file carried by a message. Never called an attachment: see ADR-0042. */
export interface InboundFile {
  filename: string;
  contentType: string;
  /** base64, as every binary payload in this product arrives. */
  bytes: string;
}

/**
 * A message as this product needs it, whatever shape the provider posted.
 *
 * Normalising is the whole of the port's job. The webhook body is the
 * provider's business — SES, Postmark and SendGrid each post something
 * different — and this is the one place that knows which.
 */
export interface InboundMessage {
  /** The address written to. Carries the token that names the project. */
  recipient: string;
  sender: string;
  subject?: string;
  body?: string;
  files: InboundFile[];
}

export interface InboundMailProvider {
  /**
   * False for the default, which is what "no adapter is written" means.
   *
   * The route needs to tell a deployment fact from a payload fact: an
   * unconfigured provider is 503 and a payload this one cannot read is 400,
   * and neither should be reported as the other. A `Transcriber` needs no
   * such flag because its refusal is recorded on a row that already exists;
   * here there is no row yet.
   */
  readonly configured: boolean;

  /** Throws on a payload it cannot read. */
  read(payload: unknown): InboundMessage;
}

export const unconfiguredInboundMailProvider: InboundMailProvider = {
  configured: false,
  read: () => {
    throw new Error('no inbound mail provider is configured');
  },
};

function fields(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('the webhook payload is not an object');
  }
  return payload as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`the webhook payload has no ${name}`);
  }
  return value;
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`the webhook payload's ${name} is not text`);
  }
  return value;
}

function file(value: unknown, index: number): InboundFile {
  const one = fields(value);
  return {
    filename: text(one['filename'], `filename on file ${index + 1}`),
    contentType: text(one['contentType'], `content type on file ${index + 1}`),
    bytes: text(one['bytes'], `bytes on file ${index + 1}`),
  };
}

/**
 * The stub, off by default and never to be pointed at a real mailbox.
 *
 * It reads one documented normalised envelope:
 *
 *     { to, from, subject?, text?, files: [{ filename, contentType, bytes }] }
 *
 * `TRANSCRIBER=stub` returns a fixed line so a screen can be exercised; this
 * one exists so the endpoint itself can be — the ticket asks that recorded
 * payloads be fed *at* the endpoint rather than injected past it, and with no
 * vendor chosen there is no captured request of anyone's shape to replay.
 * Every refusal below is a payload a real provider could post, so what the
 * tests exercise is the route's handling of a bad one and not the stub's.
 */
export const stubInboundMailProvider: InboundMailProvider = {
  configured: true,
  read: (payload) => {
    const message = fields(payload);
    const files = message['files'] ?? [];
    if (!Array.isArray(files)) {
      throw new Error("the webhook payload's files are not a list");
    }
    return {
      recipient: text(message['to'], 'recipient'),
      sender: text(message['from'], 'sender'),
      subject: optionalText(message['subject'], 'subject'),
      body: optionalText(message['text'], 'body'),
      files: files.map(file),
    };
  },
};

/**
 * The adapter this deployment runs. Read once, at the boundary, so nothing
 * below here asks an environment variable what it is talking to.
 */
export function inboundMailProviderFromEnv(): InboundMailProvider {
  return process.env['INBOUND_MAIL'] === 'stub'
    ? stubInboundMailProvider
    : unconfiguredInboundMailProvider;
}
