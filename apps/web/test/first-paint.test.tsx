import { act } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { SiteVisitReport } from '../app/api';
import { ReportProgress } from '../app/report-form';

/**
 * A first paint has to be in the server's render (ADR-0028).
 *
 * The defect this exists to catch is the quietest one in this frontend: a
 * state update made from a ref callback or an effect during the **hydration**
 * commit is discarded. The ref runs, the value it computes is right, and the
 * render keeps the old one. Nothing throws, nothing warns in production, the
 * types are all correct, and the screen shows yesterday's number.
 *
 * So `useLiveList` seeds its state from a prop and lets the stream correct it
 * afterwards, never the other way round — and these tests assert both halves:
 * that the server paints the seeded value, and that hydrating over that markup
 * neither blanks it nor disagrees with it before a single event has arrived.
 *
 * `EventSource` does not exist in jsdom and is deliberately not implemented
 * here beyond a recorder. A first paint that needed one would be the bug.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

function report(id: string, state: SiteVisitReport['state']): SiteVisitReport {
  return {
    id,
    siteVisitId: 'visit-1',
    renderingSince: null,
    renderedAt: null,
    byteSize: null,
    failedAt: null,
    failure: null,
    createdAt: '2026-09-05T09:00:00.000Z',
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
  // A hydration mismatch is a `console.error` and not a throw, so a test that
  // did not watch this one would pass while React quietly patched the screen.
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
  vi.restoreAllMocks();
});

test('the count is in the markup the server sends', () => {
  const markup = renderToString(
    <ReportProgress
      siteVisitId="visit-1"
      initial={[report('a', 'rendered'), report('b', 'rendered')]}
    />,
  );

  expect(markup).toContain('2 generated');
  // And it got there without a stream: the server has no `EventSource` and
  // this is the whole reason `initial` is a prop rather than an initial fetch.
  expect(opened).toEqual([]);
});

test('hydrating over that markup keeps it, before any event arrives', () => {
  const initial = [report('a', 'rendered'), report('b', 'rendering')];
  container.innerHTML = renderToString(
    <ReportProgress siteVisitId="visit-1" initial={initial} />,
  );
  expect(container.textContent).toContain('rendering 1 of 2');

  act(() => {
    root = hydrateRoot(
      container,
      <ReportProgress siteVisitId="visit-1" initial={initial} />,
    );
  });

  // Still the server's answer. If the value were set from an effect or a ref
  // during this commit instead of seeded from the prop, this is the line that
  // would read the empty state.
  expect(container.textContent).toContain('rendering 1 of 2');
  expect(errors).toEqual([]);

  // The stream opens after the commit, which is the ordering that makes the
  // seed necessary in the first place.
  expect(opened).toEqual(['/site-visits/visit-1/reports/stream']);
});

test('what the server was not given is not on the first paint either', () => {
  // The other side of the same rule, and the reason it is not free: a
  // component cannot invent a value the server did not render. An empty seed
  // paints the empty state, and the page says so honestly rather than showing
  // a count it is about to correct.
  const markup = renderToString(
    <ReportProgress siteVisitId="visit-1" initial={[]} />,
  );

  expect(markup).toContain('not generated yet');
  expect(markup).not.toContain('generated</span>');
});
