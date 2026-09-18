/**
 * The WCAG AA contrast measurement, every screen, both themes (issue #117,
 * ADR-0059 point 4).
 *
 * The 2026-09-17 baseline in the vault's `docs/walk-protocol.md` was taken
 * "in the browser off computed styles" and **left nothing behind that
 * reproduces it**. This is that procedure written down, so the redesign
 * tickets after this one re-measure the same way rather than a new way:
 *
 *   - every visible text node's resolved colour against its **effective**
 *     background, composited through any translucent layer;
 *   - the threshold is 4.5:1, or 3:1 at 24 px and at 18.66 px bold;
 *   - the worst value on the screen is the screen's figure.
 *
 * A colour is resolved by painting it into a 1×1 canvas and reading the pixel
 * back, which is what the browser paints and not what the stylesheet says —
 * the two differ whenever a token is outside sRGB, as **both** `--destructive`
 * values were before this ticket. The design brief computes the same numbers
 * from the oklch values through OKLab; they agree to within one 8-bit step a
 * channel, because the browser mixes `bg-destructive/10` in oklab where the
 * brief mixes in sRGB. **This file is the number of record and the brief's
 * table is not** — that is what ADR-0059 point 4 asks for.
 *
 * Not a test and not a CI gate. It needs a browser, a running `pnpm dev` and a
 * database with a job in it, which is three things `pnpm test` deliberately
 * does not have (ADR-0049). Run it through a Playwright driver:
 *
 *     const { run, markdown } = await import('file:///…/scripts/contrast.mjs');
 *     const rows = await run(page, {
 *       baseUrl: 'http://localhost:3000',
 *       email, password,
 *       ids: { projectId, issueProjectId, issueNumber, registerId, … },
 *     });
 *     console.log(markdown(rows));
 *
 * Playwright is **not a dependency of this repository** and is not meant to
 * become one — nothing in CI runs this. Any driver that can hand it a `page`
 * will do.
 *
 * `run` returns rows; `markdown(rows)` prints the table that goes in the
 * vault beside the baseline.
 */

/**
 * The fifteen signed-in screens, by route shape.
 *
 * **What to measure belongs in this file too**, not only how: a later
 * measurement that walked a different set would not be comparable with the one
 * in the vault, and "every screen" is a claim about a set. It is every
 * `page.tsx` under `apps/web/app` less the sign-in screen, which `run` takes
 * separately below because it is the one screen measured signed out.
 *
 * A route carrying a `:name` is filled from the `ids` given to `run`, which are
 * a fact about a database and not about the product. Pick records with
 * something on them — the figures below are the *worst* text on the screen, and
 * an empty screen has nothing to be worst.
 */
export const SCREENS = [
  { screen: 'This morning', route: '/' },
  { screen: 'Pending items', route: '/pending' },
  { screen: 'Exposure', route: '/exposure' },
  { screen: 'Clock', route: '/clock' },
  { screen: 'Open issues', route: '/issues' },
  { screen: 'People', route: '/users' },
  { screen: 'Project record', route: '/projects/:projectId' },
  { screen: 'Project activity', route: '/projects/:projectId/activity' },
  { screen: 'Project memory', route: '/projects/:projectId/memory' },
  { screen: 'Issue record', route: '/projects/:issueProjectId/issues/:issueNumber' },
  { screen: 'Register log', route: '/registers/:registerId' },
  { screen: 'Register entry', route: '/register-entries/:registerEntryId' },
  { screen: 'Site visit record', route: '/site-visits/:siteVisitId' },
  { screen: 'Submission record', route: '/submissions/:submissionId' },
  {
    screen: 'Extraction confirm',
    route: '/projects/:extractionProjectId/extractions/:extractionId',
  },
];

/** `SCREENS` with the ids filled in. Throws rather than walking a `:name`. */
export function routesFor(ids) {
  return SCREENS.map(({ screen, route }) => ({
    screen,
    route: route.replace(/:(\w+)/g, (_, name) => {
      const value = ids[name];
      if (value === undefined) {
        throw new Error(`${screen}: no id given for ':${name}'`);
      }
      return value;
    }),
  }));
}

/**
 * What runs **inside the page**. No Playwright here on purpose: the same
 * function serialises into any driver, and a later measurement that used a
 * different definition of "visible" would not be comparable with this one.
 */
export function measureInPage() {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const paint = canvas.getContext('2d', { willReadFrequently: true });

  /** Any CSS colour string as the browser paints it: sRGB plus alpha. */
  const resolve = (value) => {
    paint.globalCompositeOperation = 'copy';
    paint.fillStyle = 'rgba(0,0,0,0)';
    paint.fillRect(0, 0, 1, 1);
    paint.fillStyle = value;
    paint.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };

  const over = (fg, bg) => [0, 1, 2].map((i) => fg[3] * fg[i] + (1 - fg[3]) * bg[i]);

  const luminance = (rgb) => {
    const linear = rgb.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };

  const ratio = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)];
    const [hi, lo] = x > y ? [x, y] : [y, x];
    return (hi + 0.05) / (lo + 0.05);
  };

  /**
   * What is actually behind this element: every ancestor's background painted
   * in turn until one of them is opaque. The page's own background is the
   * floor, and white is the floor under that — a document with no background
   * declared paints white.
   */
  const backgroundUnder = (element, { from = element } = {}) => {
    const layers = [];
    for (let node = from; node !== null; node = node.parentElement) {
      const layer = resolve(getComputedStyle(node).backgroundColor);
      if (layer[3] === 0) continue;
      layers.push(layer);
      if (layer[3] === 1) break;
    }
    const root = resolve(getComputedStyle(document.documentElement).backgroundColor);
    let composited = root[3] === 1 ? root.slice(0, 3) : [255, 255, 255];
    for (const layer of layers.reverse()) composited = over(layer, composited);
    return composited;
  };

  /**
   * Visible means painted and readable: on the page, not clipped to a
   * screen-reader sliver, not transparent, and carrying words of its own.
   */
  const visible = (element) => {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (Number(style.opacity) === 0) return false;
    const box = element.getBoundingClientRect();
    // `sr-only` is a 1 px clipped box. It is read aloud, never read.
    return box.width > 1 && box.height > 1;
  };

  /** The AA threshold for text of this size and weight. */
  const threshold = (style) => {
    const px = Number.parseFloat(style.fontSize);
    const weight = Number(style.fontWeight);
    const large = px >= 24 || (px >= 18.66 && weight >= 700);
    return large ? 3 : 4.5;
  };

  const text = [];
  const nonText = [];

  for (const element of document.body.querySelectorAll('*')) {
    if (!visible(element)) continue;
    const style = getComputedStyle(element);

    const own = [...element.childNodes].some(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== '',
    );
    if (own) {
      const background = backgroundUnder(element);
      const foreground = over(resolve(style.color), background);
      text.push({
        ratio: ratio(foreground, background),
        needs: threshold(style),
        font: `${Number.parseFloat(style.fontSize)}px/${style.fontWeight}`,
        words: (element.textContent ?? '').trim().slice(0, 48),
      });
    }

    // Non-text had no bar at all until ADR-0059 and AA asks 3:1 of a UI
    // component. A field outline is one; a separator between two rows is
    // decoration and has no bar.
    //
    // **Both sides of the outline, and the better one is the figure.** WCAG
    // 1.4.11 asks 3:1 against the *adjacent* colours, and a field has two: the
    // surface outside it and its own fill inside. In the dark theme those
    // differ — every field carries `dark:bg-input/30`, so the fill is the
    // outline's own colour at 30% and the inside reading is necessarily the
    // worse one. Taking it alone would report a failure where the field is
    // plainly identifiable against the card, which is what the bar is for.
    const tag = element.tagName.toLowerCase();
    const control = tag === 'input' || tag === 'select' || tag === 'textarea';
    if (control && style.borderTopWidth !== '0px') {
      const ink = resolve(style.borderTopColor);
      const inside = backgroundUnder(element);
      const outside = backgroundUnder(element, { from: element.parentElement });
      const against = (surface) => ratio(over(ink, surface), surface);
      nonText.push({
        ratio: Math.max(against(outside), against(inside)),
        outside: against(outside),
        inside: against(inside),
        needs: 3,
        what: `${tag} outline`,
      });
    }
  }

  const worst = (rows) =>
    rows.reduce((low, row) => (low === null || row.ratio < low.ratio ? row : low), null);

  return {
    counted: text.length,
    worstText: worst(text),
    failing: text
      .filter((row) => row.ratio < row.needs)
      .sort((a, b) => a.ratio - b.ratio)
      .slice(0, 5),
    worstControl: worst(nonText),
    tokens: (() => {
      const style = getComputedStyle(document.documentElement);
      const names = ['--destructive', '--muted-foreground', '--input', '--ring', '--border'];
      return Object.fromEntries(
        names.map((name) => [name, resolve(style.getPropertyValue(name)).join(',')]),
      );
    })(),
  };
}

/**
 * Load a screen and let it settle.
 *
 * **Not `networkidle`.** Four of these screens hold an `EventSource` open for
 * as long as they are on screen (ADR-0035), so the network is never idle and a
 * wait for it times out rather than measuring. The markup is the server's on
 * every one of them, so `load` is the moment there is something to measure,
 * and the pause after it is for the web font — a fallback face would change
 * the size a threshold is chosen by, not the colour.
 */
async function show(page, url) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(250);
}

/** Sign in through the form, which is the only way in (ADR-0055). */
async function signIn(page, { baseUrl, email, password }) {
  await show(page, `${baseUrl}/sign-in`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 15000 });
}

/** Set the signed-in person's theme through the nav control, not by class. */
async function chooseTheme(page, { baseUrl }, theme) {
  await show(page, `${baseUrl}/`);
  await page.click(`button[name="theme"][value="${theme}"]`);
  await page.waitForLoadState('load');
  await page.waitForTimeout(250);
}

export async function run(page, options) {
  const { baseUrl, ids, routes = routesFor(ids ?? {}) } = options;
  await page.setViewportSize({ width: 1280, height: 800 });

  const rows = [];

  // Signed out, and the system's preference is the only answer there is.
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await show(page, `${baseUrl}/sign-in`);
    rows.push({
      screen: 'Sign in',
      route: '/sign-in',
      theme: scheme,
      how: 'system preference',
      ...(await page.evaluate(measureInPage)),
    });
  }

  await page.emulateMedia({ colorScheme: 'light' });
  await signIn(page, options);

  /** Three passes: the two overrides, then the system preference under them. */
  const passes = [
    { theme: 'LIGHT', scheme: 'light', label: 'light', how: 'override' },
    { theme: 'DARK', scheme: 'light', label: 'dark', how: 'override' },
    { theme: 'SYSTEM', scheme: 'dark', label: 'dark', how: 'system preference' },
  ];

  for (const pass of passes) {
    await page.emulateMedia({ colorScheme: 'light' });
    await chooseTheme(page, options, pass.theme);
    await page.emulateMedia({ colorScheme: pass.scheme });

    for (const { screen, route } of routes) {
      await show(page, `${baseUrl}${route}`);
      rows.push({
        screen,
        route,
        theme: pass.label,
        how: pass.how,
        ...(await page.evaluate(measureInPage)),
      });
    }
  }

  // Left as it was found, so a measurement never changes the record.
  await page.emulateMedia({ colorScheme: 'light' });
  await chooseTheme(page, options, 'SYSTEM');
  return rows;
}

/** The table that goes in the vault beside the baseline. */
export function markdown(rows) {
  const cell = (row) =>
    row.worstText === null ? '—' : `${row.worstText.ratio.toFixed(2)}:1`;
  const verdict = (row) =>
    row.worstText === null
      ? '—'
      : row.worstText.ratio >= row.worstText.needs
        ? 'passes'
        : '**fails**';
  return [
    '| Screen | Theme | How | Lowest text contrast | Against AA | Nodes |',
    '|---|---|---|---|---|---|',
    ...rows.map(
      (row) =>
        `| ${row.screen} \`${row.route}\` | ${row.theme} | ${row.how} | ${cell(row)} | ${verdict(row)} | ${row.counted} |`,
    ),
  ].join('\n');
}
