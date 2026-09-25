import {
  CircleAlert,
  DraftingCompass,
  ListChecks,
  LogOut,
  Search,
  SearchCheck,
  Sunrise,
  Timer,
  TriangleAlert,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import type { Project, SignedInUser } from './api';
import { NavLink } from './nav-link';
import { PhoneMenu } from './phone-menu';
import { signOut } from './sign-in/actions';
import { ThemeForm } from './theme-form';

/**
 * The app shell (ADR-0069 D2, issue #171): a 256 px sidebar at 1024 px and
 * wider, and below that a 56 px top bar whose nav is behind one *Menu*.
 *
 * It replaced a two-row text header that had no active state, did not carry
 * *Open issues*, and cost ~200 px on a phone before a screen's title (#120 had
 * made it wrap, which is what stopped it widening the document). The sidebar
 * is `hidden` below `lg` and the top bar is `lg:hidden`, so exactly one of them
 * is ever in the accessibility tree; the two navs are named apart anyway.
 *
 * **Signed out, there is no nav** — only the mark. Nothing it links to would
 * render for nobody, and the sign-in screen is the one screen with one job.
 *
 * The top bar is not sticky on purpose: the walk's jumper is the sticky bar on
 * the screen used one-handed, and two sticky bars would stack over its content.
 */
export function AppShell({
  user,
  jobs,
}: {
  user: SignedInUser | undefined;
  /** The live jobs, which the sidebar lists one click away. */
  jobs: Project[];
}) {
  if (user === undefined) {
    return (
      <header className="flex h-14 items-center px-4 sm:px-6">
        <Mark />
      </header>
    );
  }

  return (
    <>
      <aside
        aria-label="Main"
        className="bg-card fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r lg:flex"
      >
        <div className="flex h-16 shrink-0 items-center px-4">
          <Mark />
        </div>
        <nav aria-label="Screens" className="flex-1 overflow-y-auto px-3 pb-3">
          <SearchBox />
          <Links />
          <Jobs jobs={jobs} />
        </nav>
        <div className="space-y-3 border-t p-3">
          <ThemeForm theme={user.theme} />
          <Account user={user} />
        </div>
      </aside>

      <header className="bg-card relative flex h-14 items-center gap-2 border-b px-4 lg:hidden">
        <Mark />
        <Link
          href="/search"
          aria-label="Search every job"
          className="text-muted-foreground hover:bg-muted hover:text-foreground ml-auto inline-flex size-11 items-center justify-center rounded-lg transition-colors"
        >
          <Search aria-hidden className="size-5" />
        </Link>
        <PhoneMenu>
          <nav aria-label="Screens">
            <Links />
            <Jobs jobs={jobs} />
          </nav>
          <div className="mt-2 space-y-2 border-t pt-2">
            <ThemeForm theme={user.theme} />
            <Account user={user} />
          </div>
        </PhoneMenu>
      </header>
    </>
  );
}

function Mark() {
  return (
    <Link href="/" className="flex min-w-0 items-center gap-2.5">
      <span className="bg-primary text-primary-foreground inline-flex size-8 shrink-0 items-center justify-center rounded-lg">
        <DraftingCompass aria-hidden className="size-4" />
      </span>
      <span className="truncate text-sm font-semibold tracking-tight">
        Engineer PM OS
      </span>
    </Link>
  );
}

/**
 * Keyword search across every job (issue #66, ADR-0067): a native GET form, so
 * it submits with no script and a search is a URL to bookmark or send, like
 * the scope toggle's two links. On a phone it is the top bar's search link to
 * the same screen, whose own box is the one to type in.
 */
function SearchBox() {
  return (
    <form action="/search" role="search" className="pb-3">
      <label className="relative block">
        <Search
          aria-hidden
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
        />
        <input
          type="search"
          name="q"
          maxLength={200}
          aria-label="Search every job"
          placeholder="Search every job"
          className="border-input bg-card h-9 w-full min-w-0 rounded-lg border pr-2 pl-8 text-sm"
        />
      </label>
    </form>
  );
}

function Group({ children }: { children: string }) {
  return (
    <p className="text-muted-foreground px-2.5 pt-3 pb-1 text-[11px] font-semibold tracking-[0.08em] uppercase">
      {children}
    </p>
  );
}

function Links() {
  return (
    <>
      <Group>Today</Group>
      {/*
        `/` is the morning screen (story 47), and the project list is a section
        under its two counts — so the nav says what the landing view is rather
        than naming one section of it.
      */}
      <NavLink href="/" exact icon={<Sunrise aria-hidden />}>
        This morning
      </NavLink>
      <NavLink href="/pending" icon={<ListChecks aria-hidden />}>
        Pending items
      </NavLink>
      <NavLink href="/exposure" icon={<TriangleAlert aria-hidden />}>
        Exposure
      </NavLink>
      <NavLink href="/clock" icon={<Timer aria-hidden />}>
        Clock
      </NavLink>
      <Group>Across the jobs</Group>
      {/* It was reachable only from a sentence on the morning screen. */}
      <NavLink href="/issues" icon={<SearchCheck aria-hidden />}>
        Open issues
      </NavLink>
      <NavLink href="/users" icon={<Users aria-hidden />}>
        People
      </NavLink>
    </>
  );
}

function Jobs({ jobs }: { jobs: Project[] }) {
  return (
    <>
      <Group>Live jobs</Group>
      {jobs.length === 0 ? (
        <p className="text-muted-foreground flex items-center gap-2 px-2.5 py-1.5 text-sm">
          <CircleAlert aria-hidden className="size-4" />
          No live jobs
        </p>
      ) : (
        jobs.map((job) => (
          <NavLink key={job.id} href={`/projects/${job.id}`}>
            <span className="text-muted-foreground shrink-0 font-mono text-[11px] whitespace-nowrap tabular-nums">
              {job.projectNumber}
            </span>
            <span className="truncate">{job.name}</span>
          </NavLink>
        ))
      )}
    </>
  );
}

function Account({ user }: { user: SignedInUser }) {
  const initials = user.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('');

  return (
    <form action={signOut} className="flex items-center gap-2.5 px-1">
      <span
        aria-hidden
        className="bg-muted text-muted-foreground inline-flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
      >
        {initials}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{user.name}</span>
      {/* Named for a screen reader and titled for a pointer: the footer is
          256 px, and a worded button cut the person's own name to its first word. */}
      <button
        type="submit"
        aria-label="Sign out"
        title="Sign out"
        className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors"
      >
        <LogOut aria-hidden className="size-4" />
      </button>
    </form>
  );
}
