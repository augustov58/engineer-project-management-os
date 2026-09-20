import { act } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { CaptureRun, Turn } from '../app/api';
import {
  ConversationProgress,
  DraftObservationForm,
  TypeATurn,
} from '../app/conversation';

/**
 * The walk's conversation panel (issue #114, ADR-0058).
 *
 * Two rules this suite already holds, reaching a new component: a first paint
 * has to be in the server's render (ADR-0028), and what a form serialises is
 * what the action reads (ADR-0025). Both are defects that *render correctly* —
 * a seeded field that did not seed looks like an empty field, and a discarded
 * hydration update looks like a slow stream — so neither `tsc` nor a
 * screenshot would catch one.
 *
 * `EventSource` does not exist in jsdom and is deliberately not implemented
 * beyond a recorder, for `first-paint.test.tsx`'s reason: a first paint that
 * needed one would be the bug.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

function capture(patch: Partial<Turn> = {}): Turn {
  return {
    id: 'turn-1',
    conversationId: 'conversation-1',
    speaker: 'ENGINEER',
    position: 1,
    kind: 'TYPED',
    captureKey: 'a-key',
    recordedAt: '2026-09-16T13:20:00.000Z',
    contentType: null,
    byteSize: null,
    transcribingSince: null,
    transcript: 'cracked tile',
    transcribedAt: null,
    failedAt: null,
    failure: null,
    createdAt: '2026-09-16T13:20:00.000Z',
    agentRunId: null,
    state: 'transcribed',
    proposal: null,
    proposedAssumptionRecord: null,
    assumptionRecord: null,
    observation: null,
    ...patch,
  };
}

function reply(patch: Partial<Turn> = {}): Turn {
  return capture({
    id: 'turn-2',
    speaker: 'AGENT',
    position: 2,
    kind: null,
    captureKey: null,
    recordedAt: null,
    transcript: null,
    agentRunId: 'run-1',
    proposal: {
      observed: 'Cracked floor tile',
      floor: '3',
      qualifier: 'Stair B',
      side: 'A',
      sector: null,
      location: 'Floor 3 — Stair B, Side A',
      issueId: null,
    },
    ...patch,
  });
}

function run(state: CaptureRun['state']): CaptureRun {
  return {
    id: `run-${state}`,
    createdAt: '2026-09-16T13:20:00.000Z',
    failure: state === 'failed' ? 'no model provider is configured' : null,
    state,
  };
}

/** Every stream the component opened, and nothing that answers one. */
const opened: string[] = [];

class RecordingEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(url: string) {
    opened.push(url);
  }
  close(): void {}
}

let container: HTMLDivElement;
let root: Root | undefined;
let errors: unknown[][];

beforeEach(() => {
  opened.length = 0;
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    value: true,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'EventSource', {
    value: RecordingEventSource,
    configurable: true,
    writable: true,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  if (root !== undefined) {
    act(() => root?.unmount());
    root = undefined;
  }
  container.remove();
  cleanup();
  vi.restoreAllMocks();
});

test('what is waiting is in the markup the server sends', () => {
  const markup = renderToString(
    <ConversationProgress
      siteVisitId="visit-1"
      initial={[capture()]}
      initialRuns={[run('queued')]}
    />,
  );

  // A typed capture with no reply yet: the run is out with the model, and that
  // is read off the conversation rather than off a run's state, because the
  // reply is what anybody here is waiting for.
  expect(markup).toContain('reading a capture');
  expect(opened).toEqual([]);
});

test('hydrating over that markup keeps it, before any event arrives', () => {
  const initial = [capture(), reply()];
  const runs = [run('finished')];
  container.innerHTML = renderToString(
    <ConversationProgress
      siteVisitId="visit-1"
      initial={initial}
      initialRuns={runs}
    />,
  );
  // Answered, so nothing is being read; the capture is a draft awaiting the
  // engineer's confirm.
  expect(container.textContent).toContain('1 awaiting review');

  act(() => {
    root = hydrateRoot(
      container,
      <ConversationProgress
        siteVisitId="visit-1"
        initial={initial}
        initialRuns={runs}
      />,
    );
  });

  expect(container.textContent).toContain('1 awaiting review');
  expect(errors).toEqual([]);
  expect(opened).toEqual(['/site-visits/visit-1/conversation/stream']);
});

test('a failed run stops reading and says so, rather than reading forever', () => {
  // The defect this catches was in a browser: *reading a capture* was derived
  // from the absence of a reply, so a run that failed left the panel claiming
  // the agent was still working on it with nothing ever coming.
  const markup = renderToString(
    <ConversationProgress
      siteVisitId="visit-1"
      initial={[capture()]}
      initialRuns={[run('failed')]}
    />,
  );

  expect(markup).not.toContain('reading');
  expect(markup).toContain('one capture the agent could not read');
  // And the draft is still the engineer's, which is what the count says.
  expect(markup).toContain('1 awaiting review');
});

test('an agent turn is never itself awaiting review', () => {
  // The agent's reply is a proposal read beside the capture it answers, and
  // never a draft anybody confirms: counting it would tell the engineer there
  // are two things to answer where there is one.
  const markup = renderToString(
    <ConversationProgress
      siteVisitId="visit-1"
      initial={[capture({ observation: null }), reply()]}
      initialRuns={[run('finished')]}
    />,
  );
  expect(markup).toContain('1 awaiting review');
  expect(markup).not.toContain('2 awaiting review');
});

test('the empty conversation says so rather than showing a count', () => {
  const markup = renderToString(
    <ConversationProgress siteVisitId="visit-1" initial={[]} initialRuns={[]} />,
  );
  expect(markup).toContain('nothing captured yet');
});

test("the confirm form is seeded with the agent's proposal, editably", () => {
  const proposed = reply().proposal!;
  container.innerHTML = renderToString(
    <DraftObservationForm
      submit={async (previous) => previous}
      transcript="cracked tile"
      proposal={proposed}
    />,
  );

  const value = (name: string) =>
    container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `[name="${name}"]`,
    )?.value;

  // Every field the proposal carried, in the server's own markup — seeded and
  // not merely available to a later effect, which is ADR-0028's rule.
  expect(value('observed')).toBe(proposed.observed);
  expect(value('floor')).toBe(proposed.floor);
  expect(value('qualifier')).toBe(proposed.qualifier);
  expect(value('axisValue')).toBe(proposed.side);
  // The axis select is the native element and carries the axis the proposal
  // used, so the pair still arrives together (ADR-0025, ADR-0030).
  expect(
    container.querySelector<HTMLSelectElement>('[name="axis"]')?.value,
  ).toBe('side');

  // Defaults and never values: every one of them stays the engineer's to
  // change, which is what makes the submit a confirmation and not an
  // acceptance.
  const observed = container.querySelector<HTMLTextAreaElement>(
    '[name="observed"]',
  )!;
  expect(observed.getAttribute('value')).toBeNull();
  expect(observed.readOnly).toBe(false);
});

test('with no proposal the form still starts from what was captured', () => {
  // The voice path, unchanged: the transcript is what the engineer corrects,
  // and nothing else is filled in for them.
  container.innerHTML = renderToString(
    <DraftObservationForm
      submit={async (previous) => previous}
      transcript="what the vendor heard"
      proposal={null}
    />,
  );

  expect(
    container.querySelector<HTMLTextAreaElement>('[name="observed"]')?.value,
  ).toBe('what the vendor heard');
  expect(
    container.querySelector<HTMLInputElement>('[name="floor"]')?.value,
  ).toBe('');
  // **Side**, which is what this form has always defaulted to. Found in a
  // browser and not by a type: `proposal?.sector === null` is `undefined` with
  // no proposal, so the optional-chained form sent every voice draft and every
  // unanswered capture to *Sector* — a control that renders perfectly and
  // silently writes the wrong axis.
  expect(
    container.querySelector<HTMLSelectElement>('[name="axis"]')?.value,
  ).toBe('side');
});

test('a proposal that chose a sector lands on sector', () => {
  container.innerHTML = renderToString(
    <DraftObservationForm
      submit={async (previous) => previous}
      transcript="cracked tile"
      proposal={{
        observed: 'Cracked floor tile',
        floor: '3',
        qualifier: 'Stair B',
        side: null,
        sector: 'NE',
        location: 'Floor 3 — Stair B, Sector NE',
        issueId: null,
      }}
    />,
  );

  expect(
    container.querySelector<HTMLSelectElement>('[name="axis"]')?.value,
  ).toBe('sector');
  expect(
    container.querySelector<HTMLInputElement>('[name="axisValue"]')?.value,
  ).toBe('NE');
});

test('a send that failed leaves the words in the box', () => {
  // The typed path's answer to a send that did not land, and the counterpart of
  // the recorder's IndexedDB hold: an engineer in a stairwell gets the refusal
  // *and* the words back. Clearing in the submit handler emptied the box before
  // the action resolved and lost them — which is what `typeATurn`'s own comment
  // promises it does not do.
  const refuse = async (previous: { added: number }) => ({
    added: previous.added,
    error: 'no signal',
  });

  render(<TypeATurn submit={refuse} />);
  const box = screen.getByLabelText('What you are seeing') as HTMLTextAreaElement;

  fireEvent.change(box, { target: { value: 'cracked tile, south stair' } });
  fireEvent.submit(box.closest('form') as HTMLFormElement);

  return waitFor(() => {
    expect(screen.getByRole('alert').textContent).toBe('no signal');
    expect(box.value).toBe('cracked tile, south stair');
  });
});

test('a send that landed clears the box, and so does the next one', async () => {
  const keys: string[] = [];
  const accept = async (previous: { added: number }, formData: FormData) => {
    keys.push(String(formData.get('captureKey')));
    return { added: previous.added + 1 };
  };

  render(<TypeATurn submit={accept} />);
  const box = screen.getByLabelText('What you are seeing') as HTMLTextAreaElement;

  fireEvent.change(box, { target: { value: 'first capture' } });
  fireEvent.submit(box.closest('form') as HTMLFormElement);
  await waitFor(() => expect(box.value).toBe(''));

  // The **second** send of a session has to clear too, which is why the clear
  // is keyed on `added` rising rather than on it being non-zero.
  fireEvent.change(box, { target: { value: 'second capture' } });
  fireEvent.submit(box.closest('form') as HTMLFormElement);
  await waitFor(() => expect(keys).toHaveLength(2));
  await waitFor(() => expect(box.value).toBe(''));

  // Two captures, two keys: a new draft is a new capture.
  expect(keys[0]).not.toBe(keys[1]);
  // And each is one the boundary admits, which is what makes the resend rule
  // reachable rather than only recorded.
  for (const key of keys) {
    expect(key).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  }
});

test('a retry after a failed send carries the same key', async () => {
  // The resend rule from this screen (ADR-0057, extended to the typed kind).
  // A request that landed and whose response was lost is retried with the key
  // the API already has, which answers 200 with the existing row — where a
  // fresh key per submit would write a second turn saying the same thing.
  const keys: string[] = [];
  let refuse = true;
  const flaky = async (previous: { added: number }, formData: FormData) => {
    keys.push(String(formData.get('captureKey')));
    if (refuse) {
      return { added: previous.added, error: 'no signal' };
    }
    return { added: previous.added + 1 };
  };

  render(<TypeATurn submit={flaky} />);
  const box = screen.getByLabelText('What you are seeing') as HTMLTextAreaElement;

  fireEvent.change(box, { target: { value: 'cracked tile' } });
  fireEvent.submit(box.closest('form') as HTMLFormElement);
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());

  refuse = false;
  fireEvent.submit(box.closest('form') as HTMLFormElement);
  await waitFor(() => expect(keys).toHaveLength(2));

  expect(keys[0]).toBe(keys[1]);
});
