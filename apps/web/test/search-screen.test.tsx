import { renderToString } from 'react-dom/server';
import { beforeEach, expect, test, vi } from 'vitest';
import * as api from '../app/api';
import RootLayout from '../app/layout';
import SearchPage from '../app/search/page';

/**
 * Keyword search on the screen (issue #66, ADR-0067).
 *
 * A box in the nav on every screen, and one page of results grouped by job,
 * each opening where its record lives. What this suite holds is what renders
 * correctly and is still wrong: a result that links to the wrong screen, an
 * excerpt from a stranger's email rendered as markup, a box that needs a
 * script to submit.
 */

vi.mock('next/font/google', () => ({
  Geist: () => ({ variable: '__variable_1a2b3c' }),
}));

vi.mock('next/navigation', () => ({
  redirect: () => {
    throw new Error('redirect');
  },
  useRouter: () => ({ refresh: () => {} }),
}));

vi.mock('../app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  searchEveryJob: vi.fn(),
  currentUser: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(api.searchEveryJob).mockReset();
  vi.mocked(api.currentUser).mockResolvedValue({
    id: 'user-1',
    name: 'Ada Lovelace',
    email: 'ada@example.test',
    theme: 'SYSTEM',
  });
});

async function paint(element: Promise<React.ReactElement>): Promise<HTMLElement> {
  const root = document.createElement('div');
  root.innerHTML = renderToString(await element);
  return root;
}

function results(q: string | undefined) {
  return paint(
    SearchPage({ searchParams: Promise.resolve(q === undefined ? {} : { q }) }) as Promise<React.ReactElement>,
  );
}

function result(patch: Partial<api.SearchResult>): api.SearchResult {
  return {
    kind: 'open-item',
    id: 'row-1',
    projectId: 'project-1',
    projectNumber: '260001',
    projectName: 'A live job',
    archived: false,
    title: 'A title',
    excerpt: null,
    linkId: 'project-1',
    ...patch,
  };
}

test('the nav carries a search box that submits without a script', async () => {
  const root = await paint(RootLayout({ children: null }) as Promise<React.ReactElement>);
  const form = root.querySelector('nav form[role="search"]');
  expect(form?.getAttribute('action')).toBe('/search');
  expect(form?.getAttribute('method') ?? 'get').toBe('get');
  const box = form?.querySelector('input[name="q"]');
  expect(box?.getAttribute('type')).toBe('search');
  expect(box?.getAttribute('aria-label')).toBe('Search every job');
  expect(box?.getAttribute('maxlength')).toBe('200');
});

test('each result opens where its record lives, grouped under its job', async () => {
  vi.mocked(api.searchEveryJob).mockResolvedValue([
    result({ kind: 'issue', id: 'i1', linkId: '7', title: 'Issue 7' }),
    result({ kind: 'extraction', id: 'x1', linkId: 'x1', title: 'RFI-017' }),
    result({ kind: 'register-entry', id: 'e1', linkId: 'e1', title: 'RFI-017 — Baseplate' }),
    result({ kind: 'observation', id: 'o1', linkId: 'visit-1', title: 'Floor 3 — Stair B' }),
    result({ kind: 'submission', id: 's1', linkId: 's1', title: 'Rev 1 to Wren' }),
    result({ kind: 'assumption-record', id: 'a1', linkId: 's1', title: 'Assumption record, NEC 2023' }),
    result({ kind: 'open-item', id: 'oi1', linkId: 'project-1', title: 'Ceiling height' }),
    result({
      kind: 'document',
      id: 'd1',
      projectId: 'project-2',
      projectNumber: '250099',
      projectName: 'Finished job',
      archived: true,
      linkId: 'project-2',
      title: 'Electrical drawing set',
    }),
  ]);

  const root = await results('baseplate');
  const links = Object.fromEntries(
    [...root.querySelectorAll('main a, a')].map((a) => [a.textContent?.trim(), a.getAttribute('href')]),
  );
  expect(links['Issue 7']).toBe('/projects/project-1/issues/7');
  expect(links['RFI-017']).toBe('/projects/project-1/extractions/x1');
  expect(links['RFI-017 — Baseplate']).toBe('/register-entries/e1');
  expect(links['Floor 3 — Stair B']).toBe('/site-visits/visit-1');
  expect(links['Rev 1 to Wren']).toBe('/submissions/s1');
  expect(links['Assumption record, NEC 2023']).toBe('/submissions/s1');
  expect(links['Ceiling height']).toBe('/projects/project-1');
  expect(links['Electrical drawing set']).toBe('/projects/project-2');

  // Two jobs, each a heading, the archived one said to be.
  const heads = [...root.querySelectorAll('h2')].map((h) => h.textContent);
  expect(heads).toEqual([
    expect.stringContaining('260001'),
    expect.stringContaining('250099'),
  ]);
  expect(heads[1]).toContain('Archived');
});

test('the match is marked, and an excerpt is text and never markup', async () => {
  vi.mocked(api.searchEveryJob).mockResolvedValue([
    result({
      kind: 'arrival',
      title: 'An arrival',
      // An arrival's body is a stranger's words.
      excerpt: 'please <img src=x onerror=alert(1)> see the \u0002sluice\u0003 gate',
    }),
  ]);

  const root = await results('sluice');
  expect(root.querySelector('mark')?.textContent).toBe('sluice');
  expect(root.querySelector('main img, img')).toBeNull();
  expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
});

test('no query asks nothing, and a search that finds nothing says so', async () => {
  const blank = await results(undefined);
  expect(api.searchEveryJob).not.toHaveBeenCalled();
  expect(blank.textContent).toContain('Search every job');

  vi.mocked(api.searchEveryJob).mockResolvedValue([]);
  const none = await results('zzz');
  expect(none.textContent).toContain('Nothing on any job matches');
});
