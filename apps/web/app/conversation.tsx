'use client';

import { useRouter } from 'next/navigation';
import {
  useActionState,
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useLiveList } from './live-list';
import { selectClassName } from './native-select';
import { held, hold, release, type HeldRecording } from './recordings';
import { ObservationFields } from './site-visit-form';
import type { AddState, CaptureRefusal } from './actions';
import {
  awaitsReview,
  isWorking,
  type CaptureRun,
  type Proposal,
  type RecordProposal,
  type Turn,
} from './api';

/**
 * The three types the API stores, in the order a browser is likely to offer
 * them. Whichever this browser can actually produce is what gets recorded.
 */
const TYPES = ['audio/webm', 'audio/mp4', 'audio/ogg'] as const;

const EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
};

/** What this browser records in, or undefined to let it choose for itself. */
function supportedType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') {
    return undefined;
  }
  return TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

/**
 * The type without its codec parameter.
 *
 * A browser reports `audio/webm;codecs=opus`, and what is stored is what is
 * served back — a parameter is not part of what the file is, and the API's
 * closed set of three names none.
 *
 * When the browser reports nothing, the type asked for is the answer, and when
 * nothing was asked for the empty string goes up. **Never a guess**: the read
 * route hands this value straight back as the response's content type under
 * `nosniff`, so audio stored as a type it is not would be a recording that
 * silently refuses to play, with the row passing every check underneath. An
 * empty string is refused by the API by the same rule as any other bad type,
 * which is the photo form's answer to a browser that cannot name a HEIC.
 */
function baseType(reported: string, requested: string | undefined): string {
  const named = (reported.split(';')[0] ?? '').trim();
  return named === '' ? (requested ?? '') : named;
}

function reason(cause: unknown): string {
  if (typeof navigator === 'undefined' || navigator.mediaDevices === undefined) {
    // The one failure that is about how the page was opened rather than about
    // permission. A phone loading this over `http://<address>:3000` is not a
    // secure context, and no browser will hand over a microphone there.
    return 'this page has to be opened over HTTPS or on localhost before a browser will allow recording';
  }
  if (cause instanceof DOMException && cause.name === 'NotAllowedError') {
    return 'the browser refused access to the microphone';
  }
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Recording an observation by speaking, one-handed, while walking (story 51).
 *
 * One large control and nothing else to hit. ADR-0025 asks for exactly this —
 * "controls sized to be hit without looking, and the primary action reachable
 * without a second hand" — and it is the reason there is no picker, no name to
 * type and no time to set.
 *
 * **Every recording is written to the device before it is sent** and removed
 * only once the API has answered (story 112). A failed send leaves it on the
 * phone; the next time this screen loads, or the moment the browser says it is
 * back online, everything still held goes up again under the same key — which
 * the API answers with the row it already has rather than a second recording.
 */
export function VoiceRecorder({
  siteVisitId,
  add,
}: {
  siteVisitId: string;
  add: (
    captureKey: string,
    recordedAt: string,
    audio: File,
  ) => Promise<CaptureRefusal | undefined>;
}) {
  const [recording, setRecording] = useState(false);
  const [waiting, setWaiting] = useState(0);
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const recorder = useRef<MediaRecorder | null>(null);
  // `setRecording(true)` only lands once `getUserMedia` has resolved, so
  // without this a second tap in that window opens a second microphone
  // stream, overwrites the first recorder and leaves the first stream's tracks
  // live — a microphone that stays on after the engineer thinks it stopped.
  const opening = useRef(false);
  const router = useRouter();

  /** Everything the device is still holding, sent oldest first. */
  const drain = useCallback(
    async (recordings: HeldRecording[]) => {
      let refused: string | undefined;
      for (const one of recordings) {
        try {
          const name = `${one.captureKey}.${EXTENSIONS[one.contentType] ?? 'webm'}`;
          const rejection = await add(
            one.captureKey,
            one.recordedAt,
            new File([one.audio], name, { type: one.contentType }),
          );
          if (rejection === undefined) {
            await release(one.captureKey).catch(() => undefined);
            continue;
          }
          refused ??= rejection.message;
          // A refusal the API will repeat — a type it does not store, a body
          // over the cap. Held, it would resend on every load and every
          // `online` for the life of the device, with a banner that never
          // clears and no way to be rid of it. The message is still shown;
          // what is dropped is the doomed retry, not the news of it.
          if (rejection.permanent) {
            await release(one.captureKey).catch(() => undefined);
          }
        } catch {
          // The send never arrived — no signal, or the tab lost the server.
          // The recording stays held and goes again next time, which is the
          // whole of what this store is for.
          refused ??= 'no signal — the recording is held on this device';
        }
      }
      setError(refused);
      setWaiting((await held(siteVisitId).catch(() => [])).length);
      router.refresh();
    },
    [add, siteVisitId, router],
  );

  // On load, and again the moment the browser says the signal is back.
  useEffect(() => {
    const reconcile = () => {
      start(async () => {
        const outstanding = await held(siteVisitId).catch(() => []);
        if (outstanding.length > 0) {
          await drain(outstanding);
        }
      });
    };
    reconcile();
    window.addEventListener('online', reconcile);
    return () => window.removeEventListener('online', reconcile);
  }, [siteVisitId, drain]);

  async function begin() {
    if (opening.current) {
      return;
    }
    opening.current = true;
    setError(undefined);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = supportedType();
      const media = new MediaRecorder(
        stream,
        type === undefined ? {} : { mimeType: type },
      );
      const parts: Blob[] = [];

      media.ondataavailable = (event) => {
        if (event.data.size > 0) {
          parts.push(event.data);
        }
      };
      media.onstop = () => {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        const contentType = baseType(media.mimeType, type);
        const audio = new Blob(parts, { type: contentType });
        const recorded: HeldRecording = {
          captureKey: crypto.randomUUID(),
          siteVisitId,
          contentType,
          // The instant the recording was made (ADR-0054). It used to be the
          // engineer's wall clock relabelled UTC, so that it would sit in the
          // same frame as a typed time; the typed times are instants now, so
          // this is one too and nothing shifts it.
          recordedAt: new Date().toISOString(),
          audio,
        };
        start(async () => {
          // Held before it is sent, so nothing is ever only in flight.
          await hold(recorded).catch(() => undefined);
          await drain([recorded]);
        });
      };

      media.start();
      recorder.current = media;
      setRecording(true);
    } catch (cause) {
      setError(reason(cause));
    } finally {
      opening.current = false;
    }
  }

  function finish() {
    recorder.current?.stop();
    recorder.current = null;
    setRecording(false);
  }

  return (
    <div className="space-y-3">
      <Button
        type="button"
        size="lg"
        variant={recording ? 'destructive' : 'default'}
        onClick={recording ? finish : () => void begin()}
        // `whitespace-normal` because the capture bar gives this a column and
        // not the page (issue #118): the button's own base is `nowrap`, and the
        // copy is the record's — story 51's words, not a label to shorten.
        className="h-16 w-full text-base leading-tight whitespace-normal"
      >
        {recording ? 'Stop and keep it' : 'Hold a moment and speak'}
      </Button>

      {/*
        Only what this device is still holding, and only when it is holding
        something (issue #118). The sentence that used to sit here — what you
        say becomes a draft you correct — is the capture bar's one hint now,
        said once for the spoken and the typed path together, because they are
        one record and two copies of that line said so twice.
      */}
      {(waiting > 0 || pending) && (
        <p className="text-muted-foreground text-xs">
          {waiting > 0 && (
            <span className="text-foreground font-medium">
              {waiting === 1
                ? 'One recording is held on this device'
                : `${waiting} recordings are held on this device`}
              , and will go up when the signal comes back.
            </span>
          )}
          {pending && ' Sending…'}
        </p>
      )}

      {error !== undefined && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  );
}

/** What the conversation's stream pushes: what was said, and what is coming. */
interface Live {
  turns: Turn[];
  runs: CaptureRun[];
}

/**
 * Progress while the vendor works and while the agent reads, over server-sent
 * events.
 *
 * Two kinds of waiting on one stream, because they are two states of one
 * record: a recording still with the vendor, and a capture whose run has not
 * settled. The number of captures is not a figure anybody computes from — it
 * is the length of the list below it (ADR-0016's rule, applied to a panel).
 *
 * **Reading is the run's state and never the absence of a reply.** A run that
 * failed leaves no turn on the conversation, so a panel that counted unanswered
 * captures would say the agent was still reading one forever — which is the
 * exact failure the stream exists to prevent for a slow transcription.
 */
export function ConversationProgress({
  siteVisitId,
  initial,
  initialRuns,
}: {
  siteVisitId: string;
  initial: Turn[];
  initialRuns: CaptureRun[];
}) {
  const live = useLiveList<Live>(
    `/site-visits/${siteVisitId}/conversation/stream`,
    { turns: initial, runs: initialRuns },
    summarise,
  );

  if (live.turns.length === 0) {
    return (
      <span className="text-muted-foreground text-xs">nothing captured yet</span>
    );
  }

  const captures = live.turns.filter((one) => one.speaker === 'ENGINEER');
  const working = captures.filter(isWorking).length;
  const toReview = live.turns.filter(awaitsReview).length;
  const reading = live.runs.filter(
    (run) => run.state === 'queued' || run.state === 'running',
  ).length;
  // A run that failed and has not been superseded by a later one: the engineer
  // hears about it once, beside the count, because the draft is still theirs to
  // write by hand and nothing is blocked by it.
  const refused = live.runs.filter((run) => run.state === 'failed').length;

  return (
    <span className="text-muted-foreground text-xs">
      {working > 0 && (
        <span className="text-foreground animate-pulse font-medium">
          {working === 1
            ? 'transcribing 1 recording'
            : `transcribing ${working} recordings`}
        </span>
      )}
      {working > 0 && reading > 0 && ' · '}
      {reading > 0 && (
        <span className="text-foreground animate-pulse font-medium">
          {reading === 1 ? 'reading a capture' : `reading ${reading} captures`}
        </span>
      )}
      {(working > 0 || reading > 0) && toReview > 0 && ' · '}
      {toReview > 0 && `${toReview} awaiting review`}
      {working === 0 && reading === 0 && toReview === 0 &&
        `${captures.length} captured`}
      {refused > 0 && (
        <span className="text-destructive">
          {' · '}
          {refused === 1
            ? 'one capture the agent could not read'
            : `${refused} captures the agent could not read`}
        </span>
      )}
    </span>
  );
}

/** What a change to this payload would change on the page. */
function summarise(live: Live): string {
  return [
    ...live.turns.map(
      (one) =>
        `${one.id}:${one.state}:${one.observation === null ? '-' : 'x'}:${one.proposal === null ? '-' : 'p'}`,
    ),
    ...live.runs.map((run) => `${run.id}:${run.state}`),
  ].join('|');
}

/**
 * The draft, read and corrected, becoming an observation (story 52; the
 * confirm ADR-0057 part 3 makes the commit).
 *
 * The very fields the typed form uses, seeded with what was captured — and,
 * where the agent has answered, with the fields it proposed. **Every one of
 * them is editable**, which is what makes this a confirmation rather than an
 * acceptance: the engineer's submit is the body of the write, and the
 * proposal is only where the boxes started.
 *
 * What was captured is never rewritten by any of it.
 */
export function DraftObservationForm({
  submit,
  transcript,
  proposal,
}: {
  submit: (previous: AddState, formData: FormData) => Promise<AddState>;
  transcript: string | null;
  proposal: Proposal | null;
}) {
  const [state, action, pending] = useActionState(submit, { added: 0 });

  // Side unless the proposal named a sector — the form's own default, and what
  // it stays when nothing proposed anything. Read off the proposal as a whole
  // and not off `proposal?.sector`, which is `undefined` rather than `null`
  // when there is no proposal: a proposal with a null sector *chose* side, and
  // no proposal at all made no choice. Both must land on side, and the
  // optional-chained form silently sent the second one to sector.
  const axis =
    proposal !== null && proposal.sector !== null ? 'sector' : 'side';

  return (
    <ObservationFields
      action={action}
      pending={pending}
      error={state.error}
      defaultObserved={proposal?.observed ?? transcript ?? ''}
      defaultFloor={proposal?.floor ?? ''}
      defaultQualifier={proposal?.qualifier ?? ''}
      defaultAxis={axis}
      defaultAxisValue={proposal?.side ?? proposal?.sector ?? ''}
      submitLabel="Record this observation"
      timeHint="Blank means when you captured it."
    />
  );
}

/**
 * A capture key the client mints, opaque and unguessable enough not to collide.
 *
 * `crypto.getRandomValues` and **not `crypto.randomUUID`**, which the recorder
 * above uses: `randomUUID` requires a secure context, and the typed path is the
 * one that has to work on a phone over `http://<address>:3000` — the very case
 * `getUserMedia` refuses and the screen tells the engineer about. A key minted
 * with `randomUUID` there would be `undefined` and the send would 400.
 *
 * Hex rather than base64url so every character is inside the boundary's
 * `^[A-Za-z0-9_-]{8,64}$`, with no padding to strip.
 */
function newCaptureKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

/**
 * Typing into the conversation (issue #114, ADR-0057).
 *
 * Beside the recorder and not instead of it: a capture is one record either
 * way, and which one the engineer reaches for is about their hands, not about
 * the walk. The wall clock is the browser's — it is the only side that knows
 * which one the engineer is reading (ADR-0054) — and it is sent as a hidden
 * field rather than read on the server, where it would be the server's.
 */
export function TypeATurn({
  submit,
  placeholder = 'Say what you can see. Floor, where on it, what is wrong.',
  label = 'What you are seeing',
}: {
  submit: (previous: AddState, formData: FormData) => Promise<AddState>;
  /**
   * What the box asks for, which is the one thing that differs between the two
   * conversations (issue #121): a walk asks what is in front of the engineer
   * and a project asks about the job. Defaulted to the walk's, so the caller
   * that was here first passes nothing.
   */
  placeholder?: string;
  label?: string;
}) {
  const [state, action, pending] = useActionState(submit, { added: 0 });
  const [text, setText] = useState('');
  // One key per draft, held until the API has it. A fresh key on every submit
  // would make a retry after a lost response a *second* turn saying what the
  // first already said — the resend rule reaches the record and never this
  // screen. Lazy, so it is minted once per draft rather than on every render.
  const [captureKey, setCaptureKey] = useState(newCaptureKey);

  /**
   * Cleared when the API has the words, and **never on submit**.
   *
   * Clearing in the submit handler empties the box before the action resolves,
   * so a send that failed — no signal in a stairwell, a 500 — left the refusal
   * on screen and nothing to retry with. The typed path's answer to a send that
   * did not land is that the words are still in the box, which is what the
   * recorder's IndexedDB hold is for the spoken one; losing them is that
   * record's defect arriving on this one.
   *
   * Keyed on `added` **rising**, not on it being non-zero: the second send of a
   * session must clear too. The ref starts where the state does, so nothing is
   * set during the hydration commit, where an update would be discarded
   * (ADR-0028).
   */
  const kept = useRef(state.added);
  useEffect(() => {
    if (state.added > kept.current) {
      kept.current = state.added;
      setText('');
      // A new draft is a new capture, so the key moves on with the words.
      setCaptureKey(newCaptureKey());
    }
  }, [state.added]);

  return (
    <form
      action={(formData) => {
        formData.set('recordedAt', new Date().toISOString());
        formData.set('captureKey', captureKey);
        action(formData);
      }}
      className="space-y-3"
    >
      {/*
        A turn's words are the **Record** step (issue #118): 16/24, not the
        `md:text-sm` the Textarea drops to at a desk. What is captured here is
        the record, not the chrome around it.
      */}
      <Textarea
        name="text"
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={3}
        required
        maxLength={4000}
        className="md:text-base"
        placeholder={placeholder}
        aria-label={label}
      />
      <Button
        type="submit"
        disabled={pending || text.trim() === ''}
        className="h-11 w-full px-4"
      >
        {pending ? 'Sending…' : 'Send'}
      </Button>
      {state.error !== undefined && (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      )}
    </form>
  );
}

/**
 * Progress on a project's conversation, over the same stream (issue #121).
 *
 * `ConversationProgress`' counterpart and deliberately its own component: a
 * project conversation has no recording and no vendor, so *transcribing* is a
 * state none of its turns can be in, and the words it counts are questions
 * rather than captures. One component with a noun passed into it would be a
 * component whose copy nobody can read off the page it is on.
 *
 * **Reading is the run's state and never the absence of a reply** — the panel's
 * rule, and for its reason: a run that failed leaves no turn, so counting
 * unanswered questions would say the agent was still reading one forever.
 */
export function ChatProgress({
  conversationId,
  initial,
  initialRuns,
}: {
  /** Null before anything has been asked, when there is nothing to stream. */
  conversationId: string | null;
  initial: Turn[];
  initialRuns: CaptureRun[];
}) {
  const live = useLiveList<Live>(
    // A path the stream route cannot serve is never opened: the hook is called
    // unconditionally, as hooks must be, and an empty path is the one value it
    // reads as *nothing to open*.
    conversationId === null ? '' : `/conversations/${conversationId}/stream`,
    { turns: initial, runs: initialRuns },
    summarise,
  );

  if (live.turns.length === 0) {
    return (
      <span className="text-muted-foreground text-xs">nothing asked yet</span>
    );
  }

  const asked = live.turns.filter((one) => one.speaker === 'ENGINEER').length;
  const reading = live.runs.filter(
    (run) => run.state === 'queued' || run.state === 'running',
  ).length;
  const refused = live.runs.filter((run) => run.state === 'failed').length;

  return (
    <span className="text-muted-foreground text-xs">
      {reading > 0 ? (
        <span className="text-foreground animate-pulse font-medium">
          {reading === 1 ? 'reading the job' : `reading ${reading} questions`}
        </span>
      ) : (
        `${asked} asked`
      )}
      {refused > 0 && (
        <span className="text-destructive">
          {' · '}
          {refused === 1
            ? 'one question the agent could not answer'
            : `${refused} questions the agent could not answer`}
        </span>
      )}
    </span>
  );
}

/**
 * The proposed assumption record, read and confirmed (issue #121, ADR-0058
 * part 4).
 *
 * `DraftObservationForm`'s counterpart: the fields seeded with what the agent
 * proposed, **every one of them editable**, and the engineer's submit is the
 * body of the write. The two blocks are `readOnly`-looking in neither sense —
 * they are ordinary boxes, because a helper's output may need a line struck
 * before it is the record, and what goes in is what the engineer submitted.
 *
 * The submission is a **native select** (ADR-0025): what it serialises is the
 * path the confirm posts to, and a styled control would be a second thing
 * between the choice and the request.
 */
export function ConfirmAssumptionRecord({
  submit,
  turnId,
  proposal,
  submissions,
}: {
  submit: (previous: AddState, formData: FormData) => Promise<AddState>;
  /**
   * The turn this proposal is on, and the only thing on the page unique to this
   * form. The ids were keyed on the **submission** and two proposals against
   * one issuance — an ordinary second ask — put four duplicated ids on the page,
   * so every label focused the first form's field. That is the `id="party"`
   * defect the register entry carried until issue #158, and it is not worth
   * having twice.
   */
  turnId: string;
  proposal: RecordProposal;
  /** The job's issuances, so the record can be pointed at the right one. */
  submissions: { id: string; revision: string; phaseName: string }[];
}) {
  const [state, action, pending] = useActionState(submit, { added: 0 });

  return (
    <form action={action} className="grid gap-3">
      <div className="grid gap-1.5">
        <label
          htmlFor={`submission-${turnId}`}
          className="text-muted-foreground text-xs"
        >
          Against which issuance
        </label>
        <select
          id={`submission-${turnId}`}
          name="submissionId"
          defaultValue={proposal.submissionId}
          className={selectClassName}
        >
          {submissions.map((set) => (
            <option key={set.id} value={set.id}>
              {set.phaseName} — {set.revision}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-1.5">
        <label
          htmlFor={`assumptions-${turnId}`}
          className="text-muted-foreground text-xs"
        >
          Assumptions
        </label>
        <Textarea
          id={`assumptions-${turnId}`}
          name="assumptions"
          defaultValue={proposal.assumptions}
          rows={6}
          required
          maxLength={4000}
          className="font-mono text-xs md:text-xs"
        />
      </div>

      <div className="grid gap-1.5">
        <label
          htmlFor={`flags-${turnId}`}
          className="text-muted-foreground text-xs"
        >
          Flags / verify
        </label>
        <Textarea
          id={`flags-${turnId}`}
          name="flags"
          defaultValue={proposal.flags}
          rows={5}
          required
          maxLength={4000}
          className="font-mono text-xs md:text-xs"
        />
      </div>

      <div className="grid gap-1.5">
        <label
          htmlFor={`edition-${turnId}`}
          className="text-muted-foreground text-xs"
        >
          Code edition
        </label>
        <Input
          id={`edition-${turnId}`}
          name="codeEdition"
          defaultValue={proposal.codeEdition}
          required
          maxLength={200}
        />
      </div>

      <Button type="submit" disabled={pending} className="h-11 px-4">
        {pending ? 'Capturing…' : 'Capture the assumption record'}
      </Button>
      {state.error !== undefined && (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      )}
    </form>
  );
}

/** A capture's state, in the words the list uses for it. */
export function CaptureState({ capture }: { capture: Turn }) {
  if (capture.observation !== null) {
    return <Badge variant="secondary">Recorded</Badge>;
  }
  switch (capture.state) {
    case 'failed':
      return <Badge variant="destructive">Not transcribed</Badge>;
    case 'transcribed':
      return <Badge variant="outline">Awaiting review</Badge>;
    case 'transcribing':
      return <Badge variant="outline">Transcribing</Badge>;
    default:
      return <Badge variant="outline">Queued</Badge>;
  }
}
