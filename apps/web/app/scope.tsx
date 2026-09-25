import Link from 'next/link';

/**
 * *Mine* or *ours* — the one toggle on the daily layer (issue #112,
 * ADR-0055 part 5).
 *
 * The outcome test reads "nothing sitting in **my** court past its clock", and
 * since ADR-0055 "my" is a user rather than the author. So the three screens
 * that answer it default to *mine* and offer one way to widen: the morning
 * screen's two counts, the two lists they drill through to, and the pending
 * items view.
 *
 * **The default lives here and not in the API.** `GET /v1/exposure`,
 * `GET /v1/clock` and `GET /v1/open-items` each mean what they have always
 * meant — every job's — and each takes `?mine=true`. Which rows an engineer is
 * shown first is the screen's decision, which is ADR-0038's rule that the
 * morning screen serves no endpoint, applied to its filter.
 */
export type Scope = 'mine' | 'ours';

/**
 * What a query string means. Anything but the one word that widens is *mine*,
 * so a bookmark carrying nothing lands on the default rather than on an error.
 */
export function scopeOf(value: string | undefined): Scope {
  return value === 'ours' ? 'ours' : 'mine';
}

/** Whether to ask the API for the caller's own. */
export function isMine(scope: Scope): boolean {
  return scope === 'mine';
}

/**
 * This screen's own URL at the other reading (issue #112).
 *
 * Here rather than spelled at each of the four screens, which is what this
 * module already exists for: `ScopeToggle` takes an `href` because each screen
 * carries its own other parameters — the job on exposure and the clock, the
 * party and the sort order on pending — and a builder repeated four times is
 * four places one of them could stop carrying them.
 *
 * *Mine* is the default, so it is the reading with **no parameter at all**: a
 * link somebody sends is the narrow one only when it says so.
 */
export function scopeHref(
  path: string,
  scope: Scope,
  params: Record<string, string | undefined> = {},
): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      query.set(name, value);
    }
  }
  if (scope === 'ours') {
    query.set('scope', 'ours');
  }
  return query.size === 0 ? path : `${path}?${query.toString()}`;
}

/**
 * Two links and not a `<form>`: this is a navigation between two readings of
 * the same screen, so each half is a URL somebody can bookmark or send, and
 * the server renders the state rather than a client holding it.
 *
 * `href` is supplied because each screen carries its own other parameters —
 * the job on exposure and the clock, the party and the sort order on pending.
 */
export function ScopeToggle({
  scope,
  href,
}: {
  scope: Scope;
  href: (scope: Scope) => string;
}) {
  return (
    <div
      className="bg-card inline-flex rounded-full border p-1 shadow-xs"
      // A group, so the name is read: a plain `div` takes none (issue #158).
      role="group"
      aria-label="Whose"
    >
      {(['mine', 'ours'] as const).map((option) => (
        <Link
          key={option}
          href={href(option)}
          aria-current={scope === option ? 'true' : undefined}
          className={
            scope === option
              ? 'bg-primary text-primary-foreground rounded-full px-4 py-1.5 text-sm font-medium'
              : 'text-muted-foreground hover:text-foreground rounded-full px-4 py-1.5 text-sm transition-colors'
          }
        >
          {option === 'mine' ? 'Mine' : 'Ours'}
        </Link>
      ))}
    </div>
  );
}
