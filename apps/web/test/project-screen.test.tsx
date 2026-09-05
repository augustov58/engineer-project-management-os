import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as api from '../app/api';
import ProjectRecord from '../app/projects/[id]/page';

/**
 * The other half of ADR-0038's asymmetry, on the project screen.
 *
 * Here the two count strips are **gated on being non-empty**, where the
 * morning screen's two cards render at zero. That is not an inconsistency
 * somebody should tidy up: on a project screen an empty count is noise beside
 * everything else the job carries, and on the morning screen the count *is*
 * the screen. Both halves are asserted — in this file and in
 * `morning-screen.test.tsx` — precisely so that making them agree fails.
 *
 * The page is rendered with every API read stubbed. It needs no server: the
 * decision under test is what the screen does with a list of length zero.
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
  const empty = [
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
    'listMemoryAudit',
    'listIngestedDocuments',
    'listExtractions',
  ] as const;
  return {
    ...actual,
    getProject: vi.fn(),
    getMemory: vi.fn(),
    ...Object.fromEntries(empty.map((name) => [name, vi.fn()])),
  };
});

const project: api.Project = {
  id: 'project-1',
  projectNumber: '260001',
  name: 'A live job',
  createdAt: '2026-09-01T09:00:00.000Z',
  archivedAt: null,
  currentPhaseId: null,
  ingestAddress: null,
  processingLocation: 'CLOUD',
  cloudSignoffReference: null,
  cloudSignoffAt: null,
};

/** Rows of the two counted lists. Only their number is read here. */
function rows(count: number): never[] {
  return Array.from({ length: count }) as never[];
}

beforeEach(() => {
  for (const value of Object.values(api)) {
    if (vi.isMockFunction(value)) {
      value.mockResolvedValue([]);
    }
  }
  vi.mocked(api.getProject).mockResolvedValue(project);
  vi.mocked(api.getMemory).mockResolvedValue({
    projectId: project.id,
    content: null,
    versions: 0,
    size: 0,
    budget: 4000,
    versionedAt: null,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function projectScreen() {
  render(await ProjectRecord({ params: Promise.resolve({ id: project.id }) }));
}

test('neither count strip is on a job with nothing on either count', async () => {
  await projectScreen();

  expect(
    screen.queryByRole('link', { name: /still standing on an unresolved/ }),
  ).toBeNull();
  expect(
    screen.queryByRole('link', { name: /past (its|their) turnaround/ }),
  ).toBeNull();
});

test('each strip appears the moment its list is not empty', async () => {
  vi.mocked(api.listExposure).mockResolvedValue(rows(2));
  vi.mocked(api.listClock).mockResolvedValue(rows(1));

  await projectScreen();

  const exposure = screen.getByRole('link', {
    name: /still standing on an unresolved/,
  });
  const clock = screen.getByRole('link', {
    name: /past (its|their) turnaround/,
  });

  // The figure the strip leads with, and the list it links to: the count is
  // that list's length, so clicking it lands on exactly what it counted.
  expect(exposure.firstElementChild?.textContent).toBe('2');
  expect(clock.firstElementChild?.textContent).toBe('1');
  expect(exposure).toHaveProperty(
    'href',
    expect.stringContaining(`/exposure?projectId=${project.id}`),
  );
  expect(clock).toHaveProperty(
    'href',
    expect.stringContaining(`/clock?projectId=${project.id}`),
  );
});
