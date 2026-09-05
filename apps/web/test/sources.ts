import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Every source file in `apps/web`, read off the disk.
 *
 * Two of the rules this suite exists to hold are rules about the *shape of
 * the source* rather than about what a component paints: that exactly one
 * module reaches the API (ADR-0020), and that every select in this product is
 * the native element (ADR-0025). Neither is a thing a render can observe —
 * a second `fetch` renders nothing, and a Radix select renders a div that
 * looks correct and serialises nothing into the form.
 *
 * Collected by walking the tree rather than listed, so a file added in a
 * later slice is covered without anybody remembering to add it here. That is
 * the same argument `apps/api`'s `routes()` makes for sweeping every
 * registered route instead of a sample (ADR-0020, ADR-0047).
 */

/**
 * `apps/web`, which is where Vitest is run from — the package directory is
 * this config's root and pnpm runs the script there whether the run started
 * here or at the repo root. `import.meta.url` is not it: under the jsdom
 * environment it is not a `file:` URL at all.
 */
const webRoot = resolve(process.cwd());

/** What is not ours: dependencies, and Next's build output. */
const skipped = new Set(['node_modules', '.next', '.turbo']);

export interface Source {
  /** Relative to `apps/web`, e.g. `app/api.ts`. */
  path: string;
  text: string;
}

function walk(directory: string, into: Source[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skipped.has(entry.name)) {
        walk(full, into);
      }
      continue;
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      into.push({
        path: relative(webRoot, full),
        text: readFileSync(full, 'utf8'),
      });
    }
  }
}

/** Every `.ts` and `.tsx` under `apps/web`, this suite's own files included. */
export function webSources(): Source[] {
  const sources: Source[] = [];
  walk(webRoot, sources);
  // A scan that found nothing passes every assertion below it. Loudly rather
  // than vacuously, then: `next.config.ts` is in every checkout of this app.
  if (!sources.some((source) => source.path === 'next.config.ts')) {
    throw new Error(`No sources found under ${webRoot}`);
  }
  return sources;
}

/** The product's own source: everything above, less this suite. */
export function productSources(): Source[] {
  return webSources().filter((source) => !source.path.startsWith('test/'));
}

/** How many times a pattern matches, which is what most of these count. */
export function occurrences(text: string, pattern: RegExp): number {
  const global = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
  return text.match(global)?.length ?? 0;
}
