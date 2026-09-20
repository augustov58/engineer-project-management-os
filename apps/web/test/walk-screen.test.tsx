import { renderToString } from 'react-dom/server';
import { beforeEach, expect, test, vi } from 'vitest';
import * as api from '../app/api';
import SiteVisitRecord from '../app/site-visits/[id]/page';

/**
 * The walk screen, redesigned to the approved plates (issue #118, ADR-0059
 * point 3; `docs/design/design-brief.md` and plates F-01…F-04 in the vault).
 *
 * Four of the decisions the brief takes are **defects that render correctly**,
 * which is this suite's whole reason for existing: a jumper anchor pointing at
 * a section that was renamed scrolls nowhere and looks fine; an observation set
 * at 14 px looks like an observation; a creation form that lost its disclosure
 * reads as a longer page rather than as a broken one; and a 32 px select on a
 * phone is only wrong under a thumb. None of them is a type error and none
 * would fail a screenshot review.
 *
 * Rendered with `renderToString` and every API read stubbed, the way
 * `theme.test.tsx` renders the layout: the markup the server sends is what
 * these decisions live in, and no effect has to run for any of them to be true
 * (ADR-0028).
 */

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
  redirect: () => {
    throw new Error('redirect');
  },
  useRouter: () => ({ refresh: () => {} }),
}));

vi.mock('../app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  getSiteVisit: vi.fn(),
  listUsers: vi.fn(),
  listIssues: vi.fn(),
  listIssuesWithoutPhotos: vi.fn(),
}));

const zone = 'America/New_York';

const observation: api.Observation = {
  id: 'observation-1',
  siteVisitId: 'visit-1',
  observed: 'Isolation room pressure monitor reads −0.01 in. w.c.',
  observedAt: '2026-09-17T13:41:00.000Z',
  floor: '4',
  qualifier: 'Room 412 (patient room)',
  side: 'A',
  sector: null,
  createdAt: '2026-09-17T13:41:00.000Z',
  location: 'Floor 4 — Room 412 (patient room), Side A',
};

const photo: api.Photo = {
  id: 'photo-1',
  siteVisitId: 'visit-1',
  filename: '260117-F4-R412-0941-01.jpg',
  takenAt: '2026-09-17T13:41:00.000Z',
  contentType: 'image/jpeg',
  byteSize: 1024,
  floor: '4',
  issueNumber: null,
  observationId: null,
  createdAt: '2026-09-17T13:41:00.000Z',
};

const visit: api.SiteVisitDetail = {
  id: 'visit-1',
  projectId: 'project-1',
  startedAt: '2026-09-17T13:12:00.000Z',
  endedAt: '2026-09-17T15:40:00.000Z',
  createdAt: '2026-09-17T13:12:00.000Z',
  visitedOn: '2026-09-17',
  conductedBy: {
    id: 'user-1',
    name: 'Ada Lovelace',
    email: 'ada@example.test',
  },
  project: {
    id: 'project-1',
    projectNumber: '260117',
    name: 'Mercy General',
    timezone: zone,
  },
  floors: [
    {
      id: 'floor-1',
      siteVisitId: 'visit-1',
      floor: '4',
      startedAt: '2026-09-17T13:14:00.000Z',
      completedAt: '2026-09-17T14:32:00.000Z',
    },
  ],
  observations: [observation],
  photos: [photo],
  conversation: {
    id: 'conversation-1',
    projectId: 'project-1',
    siteVisitId: 'visit-1',
    createdAt: '2026-09-17T13:12:00.000Z',
    turns: [],
    runs: [],
  },
  reports: [],
};

beforeEach(() => {
  vi.mocked(api.getSiteVisit).mockResolvedValue(visit);
  vi.mocked(api.listUsers).mockResolvedValue([visit.conductedBy]);
  vi.mocked(api.listIssues).mockResolvedValue([]);
  vi.mocked(api.listIssuesWithoutPhotos).mockResolvedValue([]);
});

/** The walk, as the server sends it. */
async function paint(): Promise<HTMLElement> {
  const markup = renderToString(
    await SiteVisitRecord({ params: Promise.resolve({ id: 'visit-1' }) }),
  );
  const root = document.createElement('div');
  root.innerHTML = markup;
  return root;
}

test('every jumper anchor lands on a section that is on the page', async () => {
  const root = await paint();

  const anchors = [...root.querySelectorAll('nav[aria-label="Sections"] a')].map(
    (link) => link.getAttribute('href'),
  );

  // Density rule 5's five, in the order the plate draws them. The order is
  // asserted and not just the set: the jumper is read left to right against a
  // page read top to bottom, and a jumper whose order disagreed with the page's
  // would send the engineer up when they tapped the next one along.
  expect(anchors).toEqual([
    '#floors',
    '#observations',
    '#conversation',
    '#photographs',
    '#report',
  ]);

  // An anchor whose target is gone scrolls nowhere and renders perfectly.
  for (const anchor of anchors) {
    expect(root.querySelector(anchor as string)).not.toBeNull();
  }
});

test('what was observed is set at the Record step and its meta is not', async () => {
  const root = await paint();

  const observed = [...root.querySelectorAll('p')].find(
    (node) => node.textContent === observation.observed,
  );
  // The brief's fifth type step, and the one the product did not have: an
  // observation read at 14 px, the same size as the label above it.
  expect(observed?.className).toContain('text-base');

  const meta = [...root.querySelectorAll('p')].find((node) =>
    node.textContent?.includes(observation.location),
  );
  expect(meta?.className).toContain('text-xs');
  expect(meta?.className).toContain('text-muted-foreground');
});

test('every creation form on the walk is behind a closed disclosure', async () => {
  const root = await paint();

  const disclosures = [...root.querySelectorAll('details')];
  // Both halves of the `+` / `−` marker are in the markup — which is the half
  // that shows is a CSS question — so the leading glyphs come off here.
  const summaries = disclosures.map(
    (one) =>
      one.querySelector('summary')?.textContent?.replace(/^[^A-Za-z]+/, '') ??
      '',
  );

  // Density rule 1. Three creation forms and one promotion, all closed: the
  // record screen shows the record.
  expect(summaries).toEqual([
    'Start a floor',
    'Record as an issue',
    'Add an observation',
    'Add the walk’s photographs',
  ]);
  expect(disclosures.filter((one) => one.hasAttribute('open'))).toEqual([]);
});

test('the control bar 3 measures is a native select at the field target', async () => {
  const root = await paint();

  const binding = root.querySelector(
    'select[aria-label="What this photograph is evidence of"]',
  );
  // Native, for ADR-0025's reason, and 44 px for density rule 6's — it was
  // `h-8`, 32 px, at the baseline, and it is the control bar 3 actually times.
  expect(binding?.tagName).toBe('SELECT');
  expect(binding?.className).toContain('h-11');

  const floor = root.querySelector(
    'select[aria-label="The floor this photograph was taken on"]',
  );
  expect(floor?.tagName).toBe('SELECT');
  expect(floor?.className).toContain('h-11');
});

/*
  `test('the field screens carry no text-lg heading')` lived here until issue
  #120. It could only name the nine files this ticket owned, because 30 heads
  were still on the desk; #120 was the rest of them, so the rule is now a sweep
  over **every** product source in `desk-screens.test.tsx` and there is no list
  to keep current. Nothing was relaxed: the wider guard is a superset of this
  one, and a `text-lg` added back to a field file still fails.
*/

/** One engineer capture awaiting review, at `position`. */
function capture(position: number, patch: Partial<api.Turn> = {}): api.Turn {
  return {
    id: `turn-${position}`,
    conversationId: 'conversation-1',
    speaker: 'ENGINEER',
    position,
    kind: 'TYPED',
    captureKey: `key-${position}`,
    recordedAt: '2026-09-17T13:41:00.000Z',
    contentType: null,
    byteSize: null,
    transcribingSince: null,
    transcript: `capture ${position}`,
    transcribedAt: '2026-09-17T13:41:00.000Z',
    failedAt: null,
    failure: null,
    createdAt: '2026-09-17T13:41:00.000Z',
    agentRunId: null,
    state: 'transcribed',
    proposal: null,
    proposedAssumptionRecord: null,
    assumptionRecord: null,
    observation: null,
    ...patch,
  };
}

/** The agent's answer at `position`: a draft, or the one question it asked. */
function answer(position: number, proposal: api.Proposal | null): api.Turn {
  return {
    ...capture(position),
    id: `turn-${position}`,
    speaker: 'AGENT',
    kind: null,
    captureKey: null,
    recordedAt: null,
    transcript: proposal === null ? 'Which floor was that on?' : null,
    agentRunId: `run-${position}`,
    proposal,
  };
}

const draft: api.Proposal = {
  observed: 'Isolation room pressure monitor reads −0.01 in. w.c.',
  floor: '4',
  qualifier: 'Room 412 (patient room)',
  side: 'A',
  sector: null,
  location: 'Floor 4 — Room 412 (patient room), Side A',
  issueId: null,
};

/** For each commit form on the panel, whose turn it is sitting inside. */
async function commitsUnder(turns: api.Turn[]): Promise<string[]> {
  vi.mocked(api.getSiteVisit).mockResolvedValue({
    ...visit,
    conversation: { ...visit.conversation, turns },
  });
  const root = await paint();
  return [...root.querySelectorAll('#conversation > ul > li')]
    .filter((one) => one.querySelector('textarea[name="observed"]') !== null)
    .map((one) => (one.className.includes('bg-muted/40') ? 'agent' : 'engineer'));
}

test('the commit sits under the agent turn that proposed, and nowhere else', async () => {
  // The brief's anatomy point 3: "the draft form inline under the agent's turn
  // that proposed it". What it writes is still the **engineer's** capture — the
  // confirm route refuses an agent turn by name — so the form moves and what it
  // is bound to does not.
  expect(await commitsUnder([capture(1), answer(2, draft)])).toEqual(['agent']);

  // An agent turn is the draft's fields *or* its one question and never both,
  // so a turn that asked one proposed nothing. A form under the question would
  // read as though the question were the draft.
  expect(await commitsUnder([capture(1), answer(2, null)])).toEqual(['engineer']);

  // No run at all — the spoken path, and a run that failed leaves no turn.
  // A failed capture is still committable: that is what stops a dead vendor
  // stopping the walk being written up.
  expect(await commitsUnder([capture(1)])).toEqual(['engineer']);

  // And exactly one form per capture, never two.
  expect(await commitsUnder([capture(1), answer(2, draft), capture(3)])).toEqual([
    'agent',
    'engineer',
  ]);
});

test('evidence reads the same under an observation and under its capture', async () => {
  // Two screens show one observation's evidence — under the observation, and
  // under the capture it was confirmed from — and issue #118 first wrote them
  // as two renderings, which is how one came to print the filenames and the
  // other not. The filename is not decoration: it is the mechanism a
  // photograph binds to a finding by, and the one fact a thumbnail cannot show.
  const evidenced = { ...photo, observationId: observation.id };
  const confirmed = {
    ...capture(1),
    observation,
  };

  vi.mocked(api.getSiteVisit).mockResolvedValue({
    ...visit,
    photos: [evidenced],
    conversation: { ...visit.conversation, turns: [confirmed] },
  });
  const root = await paint();

  for (const section of ['#observations', '#conversation']) {
    const where = root.querySelector(section) as HTMLElement;
    expect(
      [...where.querySelectorAll('img')].map((img) => img.getAttribute('alt')),
    ).toEqual([photo.filename]);
    expect(where.textContent).toContain(photo.filename);
  }
});
