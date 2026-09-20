import { renderToString } from 'react-dom/server';
import { beforeEach, expect, test, vi } from 'vitest';
import * as api from '../app/api';
import RootLayout from '../app/layout';
import Home from '../app/page';
import ProjectRecord from '../app/projects/[id]/page';
import RegisterEntryRecord from '../app/register-entries/[id]/page';
import SubmissionRecord from '../app/submissions/[id]/page';
import { productSources } from './sources';

/**
 * The desk screens, redesigned to the approved plates (issue #120, ADR-0059
 * point 3; `docs/design/design-brief.md` and plates D-01…D-04 in the vault).
 *
 * Same reason as `walk-screen.test.tsx`: every decision asserted here is a
 * **defect that renders correctly**. A creation form that lost its disclosure
 * reads as a longer page rather than as a broken one; a resolved item that
 * jumped straight to *Resolved* looks exactly like one that stayed; a record
 * screen left at desk width is a wider line and not an error; and a nav that
 * stopped wrapping is only wrong on a phone. None is a type error and none
 * would fail a screenshot review at 1280 px.
 *
 * `ADR-0038`'s two rules are asserted next door, in `morning-screen.test.tsx`
 * and `project-screen.test.tsx`, and nothing here touches them.
 */

// `next/font` hands back a generated class rather than a readable one, and the
// layout is rendered here for the nav. `theme.test.tsx` stubs it the same way.
vi.mock('next/font/google', () => ({
  Geist: () => ({ variable: '__variable_1a2b3c' }),
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
  redirect: () => {
    throw new Error('redirect');
  },
  useRouter: () => ({ refresh: () => {} }),
}));

vi.mock('../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof api>();
  const lists = [
    'listProjects',
    'listOpenItems',
    'listPhases',
    'listSubmissions',
    'listExposure',
    'listSiteVisits',
    'listIssues',
    'listRegisters',
    'listClock',
    'listDocuments',
    'listMemoryRuns',
    'listMemoryProposals',
    'listIngestedDocuments',
    'listExtractions',
    'listUsers',
    'listAssumptionRecords',
    'listSubmissionDocuments',
    'listRegisterEntryDocuments',
  ] as const;
  return {
    ...actual,
    getProject: vi.fn(),
    getMemory: vi.fn(),
    getSubmission: vi.fn(),
    getRegisterEntry: vi.fn(),
    getRegister: vi.fn(),
    currentUser: vi.fn(),
    ...Object.fromEntries(lists.map((name) => [name, vi.fn()])),
  };
});

const zone = 'America/New_York';

const user: api.User = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'ada@example.test',
};

const project: api.Project = {
  id: 'project-1',
  projectNumber: '260117',
  name: 'Mercy General — 4th Floor ICU Renovation',
  createdAt: '2026-09-01T09:00:00.000Z',
  timezone: zone,
  archivedAt: null,
  currentPhaseId: null,
  ingestAddress: null,
  processingLocation: 'CLOUD',
  cloudSignoffReference: null,
  cloudSignoffAt: null,
};

/** One open item, unresolved unless a resolution is patched over it. */
function openItem(id: string, patch: Partial<api.OpenItem> = {}): api.OpenItem {
  return {
    id,
    subjectType: 'PROJECT',
    subjectId: project.id,
    unresolved: `Raceway material to panel 4LB (${id})`,
    blocks: 'The T-1 riser',
    waitingOn: 'Contractor',
    waitingSince: '2026-09-02T09:00:00.000Z',
    invalidationTrigger: null,
    counterfactual: 'X3 rises to about 41 000 A',
    owner: user,
    resolvedAt: null,
    resolutionNote: null,
    ...patch,
  };
}

const resolvedItem = openItem('item-resolved', {
  resolvedAt: '2026-09-18T09:00:00.000Z',
  resolutionNote: 'Confirmed steel',
});

beforeEach(() => {
  for (const value of Object.values(api)) {
    if (vi.isMockFunction(value)) {
      value.mockResolvedValue([]);
    }
  }
  vi.mocked(api.getProject).mockResolvedValue(project);
  vi.mocked(api.currentUser).mockResolvedValue({ ...user, theme: 'SYSTEM' });
  vi.mocked(api.listUsers).mockResolvedValue([user]);
  vi.mocked(api.getMemory).mockResolvedValue({
    projectId: project.id,
    content: null,
    versions: 0,
    size: 0,
    budget: 4000,
    versionedAt: null,
  });
});

/** Any server component's markup, as the server sends it (ADR-0028). */
async function paint(element: Promise<React.ReactElement>): Promise<HTMLElement> {
  const root = document.createElement('div');
  root.innerHTML = renderToString(await element);
  return root;
}

function projectRecord(kept?: string) {
  return paint(
    ProjectRecord({
      params: Promise.resolve({ id: project.id }),
      searchParams: Promise.resolve({ kept }),
    }) as Promise<React.ReactElement>,
  );
}

/** Every disclosure's summary, with the `+` / `−` marker stripped. */
function summaries(root: HTMLElement): string[] {
  return [...root.querySelectorAll('details')].map(
    (one) =>
      one.querySelector('summary')?.textContent?.replace(/^[^A-Za-z]+/, '') ??
      '',
  );
}

test('text-lg has left the product entirely', () => {
  // The brief's `## The type scale`: 35 section heads costing 28 px of line
  // each, for information a 12 px rule-under head carries better — "the single
  // largest source of the page lengths" the density rules are against.
  //
  // This **supersedes** `walk-screen.test.tsx`'s field-scoped guard, which
  // could only name the nine files issue #118 owned while 30 heads were still
  // on the desk. The desk was the rest of them, so the rule is now a sweep over
  // every product source and there is no list to keep current.
  const offenders = productSources()
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

test('the app shell nav wraps, so nothing makes the document wider than the phone', async () => {
  const root = await paint(
    RootLayout({ children: null }) as Promise<React.ReactElement>,
  );

  // Density rule 7, and the one thing left that scrolled sideways on a phone:
  // a non-wrapping flex inside `<body>` propagates its 735 px min-content width
  // to the document, so the walk screen scrolled too though its own content was
  // 390 px. Both rows, because either one alone still pins the width.
  const nav = root.querySelector('nav');
  expect(nav?.className).toContain('flex-wrap');
  for (const row of nav?.querySelectorAll(':scope > div') ?? []) {
    expect(row.className).toContain('flex-wrap');
  }
});

test('every creation form on the project record is behind a closed disclosure', async () => {
  vi.mocked(api.listRegisters).mockResolvedValue([]);
  const root = await projectRecord();

  // Density rule 1. The record screen shows the record; what adds to it is a
  // native `<details>`, closed — native so the `<form>` inside is untouched,
  // which is ADR-0025's rule reaching a container.
  expect(summaries(root)).toEqual([
    'Add an open item',
    'Submissions (none issued yet)',
    'Record a submission',
    'Site visits (no walks yet)',
    'Record a site visit',
    'Issues (nothing found yet)',
    'Registers',
    'Documents (nothing stored yet)',
    'Store a document',
    'Arrived (nothing yet)',
    'Record what arrived',
    'Extractions (nothing awaiting an answer)',
    'Memory (nothing written yet)',
    'Phases (0)',
  ]);
  expect(
    [...root.querySelectorAll('details')].filter((one) =>
      one.hasAttribute('open'),
    ),
  ).toEqual([]);
});

test('the project record is the one screen at both measures', async () => {
  const root = await projectRecord();

  // Head and count strips at the desk's 1024 px, sections at the record's
  // 704 px (the brief's `## The spacing scale, and the measure`). A screen that
  // used neither would silently be desk-width, which is exactly what this was.
  const record = root.querySelector('[class*="--measure-record"]');
  expect(record).not.toBeNull();
  expect(record?.textContent).toContain('Open items');
  // The head is outside it: the job's name and its two counts compare across
  // the job rather than being a record read.
  expect(record?.textContent).not.toContain(project.name);
});

test('the project record carries no conversation, which is issue #121', async () => {
  const root = await projectRecord();

  // Plate D-02 draws the project conversation as the same panel the walk has,
  // and the brief is explicit that whether the project chat exists is
  // ADR-0058's ticket: *"this brief specifies the panel it will use when it
  // does"*. Nothing creates a project-level conversation yet, so a panel here
  // would have nothing behind it. Asserted rather than merely absent, so that
  // #121 adding it is a deliberate act against a failing test.
  expect(root.textContent).not.toContain('Conversation');
});

test('the item just resolved keeps its place, and only the next load files it', async () => {
  vi.mocked(api.listOpenItems).mockImplementation(
    async (_id?: string, resolved?: boolean) =>
      resolved === true ? [resolvedItem] : [openItem('item-open')],
  );

  // Density rule 4, and the baseline's one *hunting* correction: reopening was
  // one action, but the row had left Open items for "Resolved (1)" 4 009 px
  // down a 4 480 px page — five screens from where the mistake was made.
  const kept = await projectRecord(resolvedItem.id);
  const openSection = kept.querySelector('section');
  expect(openSection?.textContent).toContain(resolvedItem.unresolved);
  expect(openSection?.textContent).toContain('Resolved just now');
  expect(openSection?.textContent).toContain('Undo');
  // It is in Open items *instead of*, not as well as: one row, one record.
  expect(summaries(kept)).not.toContain('Resolved (1)');

  // And the next load files it, which is the other half of the rule.
  const next = await projectRecord();
  expect(summaries(next)).toContain('Resolved (1)');
  expect(next.querySelector('section')?.textContent).not.toContain(
    resolvedItem.unresolved,
  );
});

test('an unknown ?kept= keeps nothing', async () => {
  vi.mocked(api.listOpenItems).mockImplementation(
    async (_id?: string, resolved?: boolean) =>
      resolved === true ? [resolvedItem] : [],
  );

  // It is a rendering instruction off the query string and never a record, so
  // a hand-typed or stale one has to be inert rather than an error.
  const root = await projectRecord('no-such-item');
  expect(summaries(root)).toContain('Resolved (1)');
  expect(root.querySelector('section')?.textContent).toContain(
    'Nothing unresolved.',
  );
});

test('the morning screen keeps its form on the landing view, behind a disclosure', async () => {
  const root = await paint(
    Home({ searchParams: Promise.resolve({}) }) as Promise<React.ReactElement>,
  );

  // Plate D-01's judgment call: **+1 tap, still 0 taps to reach**. The form was
  // the tallest thing on the one screen whose job is to be read in ten seconds,
  // and it is used once a job.
  expect(summaries(root)).toEqual(['Add a project']);
  expect(root.querySelector('details')?.hasAttribute('open')).toBe(false);
});

/** One submittal entry, its ball in our court and past its clock. */
function entry(patch: Partial<api.RegisterEntry> = {}): api.RegisterEntry {
  const handoff: api.BallInCourt = {
    id: 'handoff-1',
    registerEntryId: 'entry-1',
    party: 'Sanderson Electric',
    inOurCourt: true,
    heldSince: '2026-09-03T09:00:00.000Z',
    createdAt: '2026-09-03T09:00:00.000Z',
    user,
  };
  return {
    id: 'entry-1',
    registerId: 'register-1',
    kind: 'SUBMITTAL',
    projectId: project.id,
    number: '26 05 33-004',
    subject: 'Conduit and fittings',
    fromParty: 'Sanderson Electric',
    toParty: 'Us',
    question: null,
    response: null,
    submissionId: null,
    turnaroundDays: 10,
    disposition: null,
    disposedAt: null,
    previousRoundId: null,
    nextRoundId: null,
    createdAt: '2026-08-28T09:00:00.000Z',
    ballInCourt: handoff,
    inCourtMs: 14 * 24 * 60 * 60 * 1000,
    pastClock: true,
    handoffs: [handoff],
    openItems: [],
    ...patch,
  };
}

test('the disposition stays one action with both inputs visible, and says the window in words', async () => {
  vi.mocked(api.getRegisterEntry).mockResolvedValue(entry());
  const root = await paint(
    RegisterEntryRecord({
      params: Promise.resolve({ id: 'entry-1' }),
    }) as Promise<React.ReactElement>,
  );

  // Bar 4, unchanged in count and closer to the top. Density rule 1 is about a
  // form that *adds to* a record; this one is the act the screen exists for, so
  // it is the one form on the desk that is **not** behind a disclosure.
  const outcome = root.querySelector('select[name="disposition"]');
  expect(outcome?.tagName).toBe('SELECT');
  expect(outcome?.closest('details')).toBeNull();

  // The baseline's only impossible correction was a disposition recorded
  // wrongly: the form vanished and the API answered 409, which the screen never
  // predicted, and the word for it was *stuck*. The window is named in words
  // before the boundary has to refuse. The **edit path** is the brief's
  // decision 3, which has no ADR, so no route moved here.
  expect(root.textContent).toContain('append-only');

  // The record measure: an entry is a record being read (plate D-03, 704 px).
  expect(root.querySelector('[class*="--measure-record"]')).not.toBeNull();
});

test('a submission says provisional in words beside the badge, naming what it stands on', async () => {
  const standing = openItem('item-standing', {
    unresolved: 'Raceway material to panel 4LB',
  });
  vi.mocked(api.getSubmission).mockResolvedValue({
    id: 'submission-1',
    projectId: project.id,
    phaseId: 'phase-1',
    issuedAt: '2026-09-12T09:00:00.000Z',
    recipient: 'Mercy General Facilities',
    recipientRole: 'Owner',
    revision: 'T-1 Schedule and riser — Rev 2',
    sheetList: 'E-101 Panel schedule T-1\nE-501 Riser diagram',
    createdAt: '2026-09-12T09:00:00.000Z',
    issuedProvisional: true,
    currentlyProvisional: true,
    supersedesId: null,
    supersededById: null,
    phase: { id: 'phase-1', projectId: project.id, name: '90% CD', position: 1 },
    project: {
      id: project.id,
      projectNumber: project.projectNumber,
      name: project.name,
      timezone: zone,
    },
    openItems: [{ ...standing, unresolvedAtIssuance: true }],
    chain: [],
  } as api.SubmissionDetail);

  const root = await paint(
    SubmissionRecord({
      params: Promise.resolve({ id: 'submission-1' }),
    }) as Promise<React.ReactElement>,
  );

  // The brief's `### Desk`: *"A submission that is provisional says so in words
  // beside the badge, not only in the badge."* Naming the item is what makes
  // the claim answerable without opening the section below it.
  const badge = [...root.querySelectorAll('span')].find(
    (one) => one.textContent === 'Provisional',
  );
  expect(badge).not.toBeUndefined();
  expect(badge?.parentElement?.textContent).toContain(
    'Issued on an open item that is still unresolved',
  );
  expect(badge?.parentElement?.textContent).toContain(standing.unresolved);

  // ADR-0027's two facts stay two, because they stop agreeing the moment an
  // item resolves: one is stamped at issuance and the other is derived.
  expect(root.textContent).toContain('Went out on unconfirmed inputs');
  expect(root.querySelector('[class*="--measure-record"]')).not.toBeNull();
});
