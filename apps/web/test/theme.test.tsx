import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as api from '../app/api';
import type { SignedInUser, Theme } from '../app/api';
import RootLayout from '../app/layout';
import { productSources } from './sources';

/**
 * The theme is written on `<html>` by the **server** (issue #117, ADR-0059
 * point 4 as the design brief's decision 2 extends it).
 *
 * This is ADR-0028's rule reaching the one element React never re-renders
 * cheaply: a theme worked out in the browser paints the other theme first and
 * then corrects it, which is the flash the brief refuses. Every page in this
 * product is a dynamic server component and this layout reads the session on
 * every request already, so the class is known before the first byte — and
 * these tests assert that it is in the string the server produces, not that
 * some effect eventually sets it.
 *
 * *System* is the absence of a class, deliberately. It is not a third colour:
 * with neither class on `<html>`, `color-scheme: light dark` in `globals.css`
 * leaves `prefers-color-scheme` to answer, which is where ADR-0059 point 4 put
 * the default. That is why "no class" is asserted rather than treated as the
 * uninteresting case.
 */

vi.mock('../app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  currentUser: vi.fn(),
}));

// What `next/font` actually hands back is a generated class, not a readable
// one — and it matters here: `cn` is `twMerge`, which would drop `font-sans`
// in favour of anything it recognises as a second font utility.
vi.mock('next/font/google', () => ({
  Geist: () => ({ variable: '__variable_1a2b3c' }),
}));

const currentUser = vi.mocked(api.currentUser);

function engineer(theme: Theme): SignedInUser {
  return {
    id: 'user-1',
    name: 'Ada Lovelace',
    email: 'ada@example.test',
    theme,
  };
}

/** The layout is an async server component; awaiting it is the render. */
async function paint(): Promise<string> {
  return renderToString(await RootLayout({ children: null }));
}

/** The class list `<html>` was served with. */
function htmlClasses(markup: string): string[] {
  const opening = markup.slice(0, markup.indexOf('>') + 1);
  const className = /class="([^"]*)"/.exec(opening);
  return className === null ? [] : className[1].split(/\s+/).filter(Boolean);
}

beforeEach(() => {
  currentUser.mockResolvedValue(engineer('SYSTEM'));
});

afterEach(() => {
  vi.clearAllMocks();
});

test('an override is a class on `<html>` in the server\'s own render', async () => {
  currentUser.mockResolvedValue(engineer('DARK'));
  expect(htmlClasses(await paint())).toContain('dark');

  currentUser.mockResolvedValue(engineer('LIGHT'));
  expect(htmlClasses(await paint())).toContain('light');
});

test('system is no class at all, so the system preference answers', async () => {
  currentUser.mockResolvedValue(engineer('SYSTEM'));

  const classes = htmlClasses(await paint());
  expect(classes).not.toContain('dark');
  expect(classes).not.toContain('light');
  // The font classes are still there: "no class" is about the theme only.
  expect(classes).toContain('font-sans');
});

test('signed in as nobody is the system case and never a broken one', async () => {
  currentUser.mockResolvedValue(undefined);

  const classes = htmlClasses(await paint());
  expect(classes).not.toContain('dark');
  expect(classes).not.toContain('light');
});

test('the control offers the three themes and says which one is on', async () => {
  currentUser.mockResolvedValue(engineer('DARK'));
  const markup = await paint();

  for (const value of ['SYSTEM', 'LIGHT', 'DARK']) {
    expect(markup).toContain(`value="${value}"`);
  }
  // Marked on the button that is current, so the state is readable without
  // colour alone — the header is where this product's only always-visible
  // control lives.
  expect(markup).toMatch(/value="DARK"[^>]*aria-pressed="true"/);
  expect(markup).toMatch(/value="SYSTEM"[^>]*aria-pressed="false"/);
});

test('nobody signed in is offered no control, having nothing to store it on', async () => {
  currentUser.mockResolvedValue(undefined);

  expect(await paint()).not.toContain('value="DARK"');
});

/**
 * The tokens are the approved brief's, and the dark half of each pair exists.
 *
 * A source-shape assertion, for the reason `session.test.ts`'s are: the defect
 * this catches is a declaration that was never written, which no render can
 * show. What the values actually *measure* in a browser is the checked-in
 * measurement this ticket also carries — this only holds the file to the
 * brief's six names.
 */
test('every token the brief moved is in the stylesheet, both halves', async () => {
  // `process.cwd()` and not `import.meta.url`: under the jsdom environment
  // that is not a `file:` URL at all (`sources.ts` says the same).
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const css = await readFile(join(process.cwd(), 'app/globals.css'), 'utf8');

  const moved: [string, string, string][] = [
    ['--destructive', 'oklch(0.52 0.2 27.325)', 'oklch(0.73 0.15 22.216)'],
    ['--muted-foreground', 'oklch(0.522 0 0)', 'oklch(0.72 0 0)'],
    ['--input', 'oklch(0.65 0 0)', 'oklch(0.55 0 0)'],
    ['--ring', 'oklch(0.55 0 0)', 'oklch(0.72 0 0)'],
    ['--border', 'oklch(0.86 0 0)', 'oklch(0.35 0 0)'],
  ];
  for (const [token, light, dark] of moved) {
    expect(css).toContain(`${token}: light-dark(${light}, ${dark});`);
  }

  // The orphan blue: the only other hue the file ever had, rendering nowhere
  // because there is no sidebar. The brief deletes it, so the token is one
  // value and not a pair. Matched on the declaration rather than on the
  // number, which the comment beside it still records.
  expect(css).toContain('--sidebar-primary: oklch(0.205 0 0);');
  expect(css).not.toMatch(/--sidebar-primary:[^;]*264\.376/);

  // The two measures the screen-group tickets consume.
  expect(css).toContain('--measure-record: 44rem;');
  expect(css).toContain('--measure-desk: 64rem;');

  // Both ways into the dark theme, which is the whole of decision 2: the class
  // the server writes, and the system preference under it.
  expect(css).toContain('@media (prefers-color-scheme: dark)');
  expect(css).toContain('color-scheme: light dark;');
});

/**
 * The memory diff is the **one** screen that paints outside the palette.
 *
 * The brief's `## Colour` calls `bg-amber-500` on the budget meter "the one
 * hard-coded colour in the app". It is not: `memory-versions.tsx` has carried
 * an emerald and a red for added and removed lines since the memory screen was
 * built, and the brief did not see them. They are left alone here on purpose
 * — a diff needs two hues to be a diff, and this palette has one, which means
 * greying them is a design decision the brief never took rather than a tidy-up
 * this ticket may make. The meter is different: nothing was lost by making it
 * a chart grey.
 *
 * So the sweep runs with one named exception, which is a property a test can
 * hold where two would be the start of a list (`gate.md`'s argument for the
 * ingest webhook). A second file appearing here is the defect.
 */
test('no screen paints a colour the palette does not name', async () => {
  const palette =
    /\b(?:bg|text|border|ring|fill|stroke|decoration|outline|from|to|via)-(?:amber|red|green|emerald|blue|slate|gray|grey|zinc|neutral|stone|orange|yellow|lime|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;

  const offenders = productSources()
    .filter(({ path }) => !path.startsWith('components/ui/'))
    .filter(({ text }) => palette.test(text))
    .map(({ path }) => path);

  expect(offenders).toEqual(['app/memory-versions.tsx']);
});
