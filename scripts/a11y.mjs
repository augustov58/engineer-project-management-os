/**
 * The automated half of the screen-reader bar's audit: WCAG 2.2 Level AA,
 * every screen, a phone width and a desk width (issue #158, ADR-0068).
 *
 * ADR-0068 sets the bar: **WCAG 2.2 AA on every screen**, heard through
 * **VoiceOver on an iPhone in Safari** for the walk and **NVDA with Chrome** at
 * the desk. This file is what an agent can measure of it, and **only** that:
 * axe-core's WCAG 2.0, 2.1 and 2.2 A and AA rules, run in the page the way
 * `contrast.mjs` runs its measurement. What a screen reader actually says —
 * the order it reads a walk in, whether a live update is announced, whether a
 * control's name makes sense out loud — is a person's to check with the
 * device in hand, against the checklist in the vault beside this file's
 * result. An automated pass is **not** the bar met; it is the part of it that
 * can be repeated without anybody.
 *
 * The screens are `contrast.mjs`'s `SCREENS`, so "every screen" is one set
 * and the two audits cannot drift onto different ones; the sign-in screen is
 * run signed out, as there.
 *
 * Not a test and not a CI gate, for `contrast.mjs`'s reasons: it needs a
 * browser, a running app and a database with a job in it. **axe-core is not a
 * dependency of this repository either** — the driver hands its source in, and
 * the version it ran is part of the result:
 *
 *     const { run, markdown } = await import('file:///…/scripts/a11y.mjs');
 *     const rows = await run(page, {
 *       baseUrl, email, password, ids,           // as contrast.mjs
 *       axeSource: readFileSync('…/axe.min.js', 'utf8'),
 *     });
 *     console.log(markdown(rows));
 */

import { routesFor, show, signIn } from './contrast.mjs';

/** WCAG 2.2 AA is every level-A and level-AA rule of 2.0, 2.1 and 2.2. */
export const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

/** The two widths: the walk's phone and the desk (the design brief's). */
export const WIDTHS = [
  { label: 'phone', width: 390, height: 844 },
  { label: 'desk', width: 1280, height: 800 },
];

/** One screen's audit, run inside the page. */
async function audit(page, axeSource) {
  if (!(await page.evaluate(() => 'axe' in window))) {
    await page.addScriptTag({ content: axeSource });
  }
  return page.evaluate(async (tags) => {
    const result = await window.axe.run(document, {
      runOnly: { type: 'tag', values: tags },
      resultTypes: ['violations', 'incomplete'],
    });
    const brief = (entry) => ({
      rule: entry.id,
      impact: entry.impact,
      help: entry.help,
      nodes: entry.nodes.length,
      targets: entry.nodes.slice(0, 3).map((node) => node.target.join(' ')),
    });
    return {
      axe: result.testEngine.version,
      violations: result.violations.map(brief),
      // What axe could not decide on its own — a person's to look at.
      incomplete: result.incomplete.map(brief),
    };
  }, TAGS);
}

export async function run(page, options) {
  const { baseUrl, ids, axeSource, routes = routesFor(ids ?? {}) } = options;
  const rows = [];

  for (const { label, width, height } of WIDTHS) {
    await page.setViewportSize({ width, height });
    await page.context().clearCookies();
    await show(page, `${baseUrl}/sign-in`);
    rows.push({ screen: 'Sign in', route: '/sign-in', width: label, ...(await audit(page, axeSource)) });

    await signIn(page, options);
    for (const { screen, route } of routes) {
      await show(page, `${baseUrl}${route}`);
      rows.push({ screen, route, width: label, ...(await audit(page, axeSource)) });
    }
  }
  return rows;
}

/** The table that goes in the vault, and the violations under it. */
export function markdown(rows) {
  const lines = [
    `axe-core ${rows[0]?.axe ?? '?'}, tags ${TAGS.join(', ')}.`,
    '',
    '| Screen | Width | Violations | Nodes | Needs a person |',
    '|---|---|---:|---:|---:|',
    ...rows.map(
      (row) =>
        `| ${row.screen} | ${row.width} | ${row.violations.length} | ${row.violations.reduce((sum, one) => sum + one.nodes, 0)} | ${row.incomplete.length} |`,
    ),
    '',
  ];
  const byRule = new Map();
  for (const row of rows) {
    for (const one of row.violations) {
      const seen = byRule.get(one.rule) ?? { ...one, screens: new Set(), nodes: 0 };
      seen.screens.add(`${row.screen} (${row.width})`);
      seen.nodes += one.nodes;
      byRule.set(one.rule, seen);
    }
  }
  for (const one of byRule.values()) {
    lines.push(
      `- **${one.rule}** (${one.impact}) — ${one.help}. ${one.nodes} nodes on ${one.screens.size} screen-widths, e.g. \`${one.targets[0] ?? ''}\`: ${[...one.screens].join(', ')}.`,
    );
  }
  return lines.join('\n');
}
