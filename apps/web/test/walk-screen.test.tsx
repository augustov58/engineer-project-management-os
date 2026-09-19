import { renderToString } from 'react-dom/server';
import { beforeEach, expect, test, vi } from 'vitest';
import * as api from '../app/api';
import SiteVisitRecord from '../app/site-visits/[id]/page';
import { productSources } from './sources';

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

test('the field screens carry no text-lg heading', () => {
  // `text-lg` leaves the product entirely (the brief's `## The type scale`):
  // 35 section heads costing 28 px of line each, for information a 12 px
  // rule-under head carries better. The desk's are issue #120's; these are
  // this ticket's, and a new one here would be the step coming back.
  const field = [
    'app/site-visits/[id]/page.tsx',
    'app/conversation-panel.tsx',
    'app/conversation.tsx',
    'app/photo-form.tsx',
    'app/site-visit-form.tsx',
    'app/issue-form.tsx',
    'app/report-form.tsx',
    'app/section-head.tsx',
    'app/disclosure.tsx',
  ];
  const offenders = productSources()
    .filter((source) => field.includes(source.path))
    // Comments stripped first: `section-head.tsx` names the step it replaces,
    // and a rule that could not be written down beside its replacement would be
    // a rule nobody could explain.
    .filter((source) =>
      /(?<![\w-])text-lg(?![\w-])/.test(
        source.text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''),
      ),
    )
    .map((source) => source.path);

  expect(offenders).toEqual([]);
});
