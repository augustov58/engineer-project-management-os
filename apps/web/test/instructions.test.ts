/**
 * `AGENTS.md` stays under the cap it states for itself.
 *
 * That file is read at the start of every session, so its length is a cost
 * paid on every task rather than a tidiness question, and it says so itself:
 * *"this file carries only what applies to every path, and stays under 8 KB"*.
 * It has gone over three times — trimmed back on 2026-09-15, 2026-09-16 and
 * 2026-09-22 — every time by growing a per-ticket history that `docs/changelog.md`
 * already held. Nothing ever checked it, which is `.claude/rules/memory.md`'s
 * own lesson reaching a document: *a number repeated where nothing checks it*
 * is how a figure stays wrong for weeks.
 *
 * Here rather than in `apps/api` because this suite needs no infrastructure to
 * run — a sentence about a markdown file should not wait on Postgres and Redis
 * to start — and because reaching out of the package for a repository file is
 * a thing this suite already does, for `fly.toml` in `healthz.test.ts`.
 *
 * The limit is written twice on purpose, here and in the sentence below it,
 * and the second assertion is what keeps the pair honest. It is `fly.toml`'s
 * arrangement in `healthz.test.ts`: the test names the value and the file has
 * to agree, so raising the cap is an edit in two places and a decision, where
 * a test reading the number out of the prose it is checking would follow the
 * prose anywhere and hold nothing.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

/** 8 KB, the figure `AGENTS.md`'s last paragraph commits to. */
const CAP = 8 * 1024;

/**
 * `CLAUDE.md` is a symlink to this, so the one file is both names and reading
 * either reads these bytes.
 */
function instructions(): string {
  return readFileSync(resolve(process.cwd(), '../../AGENTS.md'), 'utf8');
}

test('AGENTS.md still states the cap this test holds it to', () => {
  // Checked before the size is, so a file that had quietly stopped claiming a
  // cap fails here saying that, rather than passing a byte count nothing in
  // the document asks for any more.
  expect(instructions()).toMatch(/stays under 8 KB/);
});

test('and AGENTS.md is under it', () => {
  const bytes = Buffer.byteLength(instructions(), 'utf8');

  // The whole file and not the prose alone: the table of path rules and the
  // vault paths are read every session too, and a cap that excused its own
  // formatting would be a cap on nothing in particular.
  expect(bytes).toBeLessThanOrEqual(CAP);
});
