import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as api from '../app/api';
import ProjectActivityPage from '../app/projects/[id]/activity/page';
import { productSources } from './sources';

/**
 * The activity feed's screen (story 107, issue #83, ADR-0048).
 *
 * Two of the three things asserted here are **absences**, and an absence is
 * exactly what the component level can see cheaply: that the screen renders no
 * figure for a list whose length is not a count, and that it offers no way to
 * walk the `?limit=` maximum. Both would render perfectly well while being
 * wrong, which is ADR-0049's own argument for this suite existing.
 *
 * No API, no database, no browser. What this does not cover is what ADR-0049
 * names: the route actually answering, the edge gate, and a real browser.
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

vi.mock('../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof api>();
  return {
    ...actual,
    getProject: vi.fn(),
    listActivity: vi.fn(),
  };
});

const project: api.Project = {
  id: 'project-1',
  projectNumber: '260001',
  name: 'A live job',
  createdAt: '2026-09-01T09:00:00.000Z',
  timezone: 'America/New_York',
  archivedAt: null,
  currentPhaseId: null,
  ingestAddress: null,
  processingLocation: 'CLOUD',
  cloudSignoffReference: null,
  cloudSignoffAt: null,
};

function line(n: number): api.AuditEntry {
  return {
    id: `entry-${n}`,
    projectId: project.id,
    action: `action.${n}`,
    detail: `what happened, number ${n}`,
    createdAt: `2026-09-0${(n % 9) + 1}T14:30:00.000Z`,
  };
}

beforeEach(() => {
  vi.mocked(api.getProject).mockResolvedValue(project);
  vi.mocked(api.listActivity).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function activityScreen() {
  render(
    await ProjectActivityPage({ params: Promise.resolve({ id: project.id }) }),
  );
}

test('it reads the activity feed and not the audit', async () => {
  await activityScreen();

  // The whole ticket: the route shipped with story 107 and had no consumer.
  expect(vi.mocked(api.listActivity)).toHaveBeenCalledWith(project.id);
});

test('every line the feed returned is on the screen, in the order given', async () => {
  const lines = [line(1), line(2), line(3)];
  vi.mocked(api.listActivity).mockResolvedValue(lines);

  await activityScreen();

  const items = screen.getAllByRole('listitem');
  expect(items).toHaveLength(3);
  // Newest first is the route's order (ADR-0048); the screen re-sorts nothing,
  // which is what keeps the two reads from disagreeing about what happened.
  expect(items.map((item) => item.textContent)).toEqual([
    expect.stringContaining('what happened, number 1'),
    expect.stringContaining('what happened, number 2'),
    expect.stringContaining('what happened, number 3'),
  ]);
});

test('the length is never rendered as a figure', async () => {
  // Thirty-seven lines, which under a default limit of 50 is the whole of
  // lately — and under a feed that had been bounded at 37 would be the bound.
  // The screen cannot tell those apart and must not print a number that says
  // it can (ADR-0048, ADR-0016).
  vi.mocked(api.listActivity).mockResolvedValue(
    Array.from({ length: 37 }, (_, index) => line(index)),
  );

  await activityScreen();

  expect(screen.queryByText(/\b37\b/)).toBeNull();
  expect(screen.queryByText(/37 (events|entries|things|lines)/i)).toBeNull();
});

test('nothing on the screen walks the limit', async () => {
  vi.mocked(api.listActivity).mockResolvedValue(
    Array.from({ length: 50 }, (_, index) => line(index)),
  );

  await activityScreen();

  // The 200 maximum is load-bearing and not a page size: a next button, a
  // page number or a "show more" would collapse story 107's two questions
  // back into one (ADR-0048).
  for (const name of [/next/i, /previous/i, /more/i, /page/i, /older/i]) {
    expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByRole('link', { name })).toBeNull();
  }
});

test('the reader passes no limit, so the route decides what lately is', () => {
  // A source scan and not a render, for `native-selects.test.tsx`'s reason:
  // a reader that passed `?limit=200` would render identically to one that
  // passed nothing, and the defect is in the request rather than the paint.
  const client = productSources().find((source) => source.path === 'app/api.ts');
  expect(client).toBeDefined();

  const reader = /export function listActivity[\s\S]*?\n}/.exec(client!.text);
  expect(reader).not.toBeNull();
  expect(reader![0]).toContain('/activity`');
  expect(reader![0]).not.toContain('limit');
});
