import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as api from '../app/api';
import Home from '../app/page';
import { productSources } from './sources';

/**
 * The morning screen (ADR-0038), which is `/`.
 *
 * Two things about it are decisions rather than layout, and both are the kind
 * a later tidy-up removes without noticing:
 *
 * **Both cards render at zero.** The project screen's count strips are gated
 * on being non-empty, and the asymmetry is intended — on a project screen an
 * empty count is noise, and here the count *is* the screen, so a card that
 * vanished would read as one that had not loaded. "Nothing on the clock" is
 * the answer this screen exists to give on a good morning.
 *
 * **It serves no endpoint.** Each count is the length of a list the card links
 * to, read unfiltered. A `GET /v1/morning` returning both would be the first
 * payload in this product from which a score could be computed without adding
 * a query — which is exactly what ADR-0016, ADR-0027 and ADR-0037 each made a
 * count a list to prevent.
 *
 * `apps/api`'s `morning.test.ts` proves the two counts are right. This file
 * proves the screen shows them, at zero as well as above it.
 */

vi.mock('../app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  listProjects: vi.fn(),
  listExposure: vi.fn(),
  listClock: vi.fn(),
}));

const listProjects = vi.mocked(api.listProjects);
const listExposure = vi.mocked(api.listExposure);
const listClock = vi.mocked(api.listClock);

/** Rows of the two lists. Only their number is read here. */
function rows(count: number): never[] {
  return Array.from({ length: count }) as never[];
}

beforeEach(() => {
  listProjects.mockResolvedValue([]);
  listExposure.mockResolvedValue(rows(0));
  listClock.mockResolvedValue(rows(0));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/**
 * The screen is an async server component; awaiting it is the render.
 *
 * `searchParams` is a promise Next hands it, and this is what stands in for
 * one — the toggle between *mine* and *ours* reads it (issue #112).
 */
async function morning(scope?: string) {
  render(await Home({ searchParams: Promise.resolve({ scope }) }));
}

/** The exposure card and the clock card, in that order. */
function cards(): [HTMLElement, HTMLElement] {
  return [
    screen.getByRole('link', { name: /issued submission/ }),
    screen.getByRole('link', { name: /register entr/ }),
  ];
}

/** The figure the card leads with, which is the whole of what it counts. */
function count(card: HTMLElement): string | null {
  return card.firstElementChild?.textContent ?? null;
}

test('both cards render at zero, and say zero', async () => {
  await morning();
  const [exposure, clock] = cards();

  expect(exposure).toHaveProperty('href', expect.stringContaining('/exposure'));
  expect(clock).toHaveProperty('href', expect.stringContaining('/clock'));
  expect(count(exposure)).toBe('0');
  expect(count(clock)).toBe('0');
});

test('each count is the length of the list its card links to', async () => {
  listExposure.mockResolvedValue(rows(3));
  listClock.mockResolvedValue(rows(7));

  await morning();
  const [exposure, clock] = cards();

  expect(count(exposure)).toBe('3');
  expect(count(clock)).toBe('7');

  // No project to narrow it: the roll-up is the same call the per-project
  // screen makes, across every job. The second argument is *mine*, which the
  // screen defaults to and the route does not (issue #112).
  expect(listExposure).toHaveBeenCalledWith(undefined, true);
  expect(listClock).toHaveBeenCalledWith(undefined, true);
});

test('the screen defaults to mine and one toggle widens it to ours', async () => {
  listExposure.mockResolvedValue(rows(3));
  listClock.mockResolvedValue(rows(7));

  // The outcome test reads "nothing sitting in **my** court past its clock",
  // and since ADR-0055 "my" is a user. The default lives here and not in the
  // API: each route means every job's, and which rows the engineer is shown
  // first is the screen's decision — ADR-0038's rule applied to the filter.
  await morning();
  expect(listExposure).toHaveBeenCalledWith(undefined, true);
  expect(listClock).toHaveBeenCalledWith(undefined, true);
  // And each card drills through carrying the toggle, so a count and the list
  // it lands on cannot be answering different questions.
  const [mineExposure, mineClock] = cards();
  expect(mineExposure.getAttribute('href')).toBe('/exposure');
  expect(mineClock.getAttribute('href')).toBe('/clock');

  cleanup();
  vi.clearAllMocks();
  listProjects.mockResolvedValue([]);
  listExposure.mockResolvedValue(rows(3));
  listClock.mockResolvedValue(rows(7));

  await morning('ours');
  expect(listExposure).toHaveBeenCalledWith(undefined, false);
  expect(listClock).toHaveBeenCalledWith(undefined, false);
  const [oursExposure, oursClock] = cards();
  expect(oursExposure.getAttribute('href')).toBe('/exposure?scope=ours');
  expect(oursClock.getAttribute('href')).toBe('/clock?scope=ours');
});

test('one of each reads as one of each', async () => {
  listExposure.mockResolvedValue(rows(1));
  listClock.mockResolvedValue(rows(1));

  await morning();
  const [exposure, clock] = cards();

  expect(exposure.textContent).toContain(
    'issued submission currently standing on an unresolved open item',
  );
  // *Mine* is the default, so the sentence is the first person; *ours* is
  // what the toggle widens it to.
  expect(clock.textContent).toContain(
    'register entry sitting in my court past its turnaround',
  );

  cleanup();
  vi.clearAllMocks();
  listProjects.mockResolvedValue([]);
  listExposure.mockResolvedValue(rows(1));
  listClock.mockResolvedValue(rows(1));

  await morning('ours');
  expect(cards()[1].textContent).toContain(
    'register entry sitting in our court past its turnaround',
  );
});

test('the screen reads two lists and no morning endpoint', () => {
  // The rule is about a path that does not exist, so it is asserted over the
  // source rather than over a render: a `/morning` call added anywhere in this
  // app is the payload ADR-0038 refused, whatever the screen looks like after.
  const naming = productSources()
    .filter((source) => source.text.includes('/morning'))
    .map((source) => source.path);

  expect(naming).toEqual([]);
});
