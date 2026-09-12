/**
 * Where the engineer goes once they are signed in.
 *
 * A file of its own, beside the action that calls it, because a `'use server'`
 * module may export nothing but async server actions — so while this lived in
 * `actions.ts` it could not be exported, and therefore could not be tested.
 * It is the one open-redirect guard in the product and it arrived as a review
 * finding on issue #22; `test/proxy.test.ts` now holds it.
 */

/**
 * Only a path on this deployment, and checked by **resolving** it rather than
 * by inspecting its first characters. `//elsewhere.example` and
 * `/\elsewhere.example` are both read by a browser as another origin — the
 * second because `URL` normalises a backslash to a slash — so a prefix test
 * has to know every spelling and a resolution test knows none. Otherwise the
 * one page an anonymous caller can reach would be a redirector to anywhere.
 */
export function destination(next: FormDataEntryValue | null): string {
  if (typeof next !== 'string' || !next.startsWith('/')) {
    return '/';
  }
  // Any base will do: what is being asked is whether the value moves off it.
  const base = 'https://gate.invalid';
  const resolved = new URL(next, base);
  if (resolved.origin !== base) {
    return '/';
  }
  return resolved.pathname + resolved.search;
}
