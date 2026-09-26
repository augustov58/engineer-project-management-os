---
paths:
  - "apps/web/**"
---
# Rules for `apps/web`

Ground rules moved out of `AGENTS.md` on 2026-09-01, none rewritten then. The test bullet was
rewritten on 2026-09-05 by issue #50, which is the one thing here that stopped being true.
Claude Code loads this file when a
path in the frontmatter is read through the Read tool; from the shell, read it yourself. The rules that
apply to every path stay in `AGENTS.md`.

- The frontend is Tailwind + shadcn/ui, components owned in `apps/web/components/ui` (ADR-0025). Where a styled component would change how a control serialises into a form, keep the native element and style it. The nobody checkbox, the pending sort select, the submission phase select, the attach-an-open-item select (on a submission and on an issue), the observation's Side/Sector axis select, the finding's category select, the select that makes a sighting another sighting of a finding already on the register and the register screen's build-one-from-a-document select (issue #108) are all native for that reason; `apps/web/app/native-select.ts` holds the shared styling.
- `pnpm test` **does** now run the frontend: `apps/web` has a `test` script (Vitest under jsdom, `apps/web/test/`) and the root `pnpm -r test` runs it, which is issue #50 and ADR-0049. What it covers is component-level and no more — that the one door to the API is the only one, that every select is the native element, that a first paint is in the server's render and survives hydration, that the morning screen's two cards render at zero where the project screen's strips do not, and, since issue #105, what `proxy.ts` does with a session cookie and what the sign-in screen's open-redirect guard refuses (`test/proxy.test.ts`; both are plain functions, so neither needs infrastructure the suite did not already have). Two files in it are not about this app at all and are here because this is the suite that needs nothing started: `test/healthz.test.ts` pins `fly.toml`'s check path, and `test/instructions.test.ts` holds `AGENTS.md` under the 8 KB it claims for itself, that file having gone over three times with nothing watching. The guard lives in `app/sign-in/destination.ts` and not in `actions.ts` because a `'use server'` module may export nothing but async server actions, which is what kept it untestable until then. What it does **not** cover is the arrangement production is: the gate end to end, the loopback API, Next serving anything, and hydration in a real browser. `pnpm typecheck` does not compile the stylesheet either. So run `pnpm --filter web build` and load the pages before calling a frontend change done, as before — the suite narrowed that rule and did not lift it. That build **needs nothing passed to it** since issue #105: it wanted a generated `EDGE_SECRET` until `next.config.ts` stopped checking for a shared secret that no longer exists, and it used to stop at config load under a `Failed to load next.config.ts` headline that read like a syntax error and was not one. That build rewrites the tracked `apps/web/next-env.d.ts` to its production paths and `next dev` rewrites it back — leave it out of the commit either way. Browse `http://localhost:3000`, not `127.0.0.1`: Next's dev-origin guard 403s the client chunks on the other host, so the page renders and silently never hydrates.
- A state update made from a ref callback during the **hydration** commit is discarded — the ref runs, the value is right, and the render keeps the old one. Anything a first paint must show has to be in the server's render: seed the state from props and let the ref only correct it afterwards (ADR-0028).
- The **morning screen** is `/`, and it serves **no endpoint** (ADR-0038). The two counts are
  `listExposure()` and `listClock()` read unfiltered and rendered as `.length`. Do not add a
  `GET /v1/morning` returning both: a payload carrying both counts is the first object in
  this product from which a score could be computed without adding a query, which is exactly
  what ADR-0027 and ADR-0037 each made one count a list to prevent. `/` is the landing view
  re-headed and not a route of its own — the project list is a section beneath the counts,
  and the nav item for `/` is named for the screen rather than for that section.
- Both morning-screen cards render **at zero**, where the project screen's two count strips
  are gated on being non-empty (ADR-0038). Different questions: on a project screen an empty
  count is noise, and on the morning screen the count *is* the screen, so a card that
  vanished would read as one that had not loaded. This asymmetry is intended.
- The morning screen's **per-job counts** (ADR-0069 D4, issue #173) are the two lists the tiles
  already read, grouped by `row.project.id` in the page — **no endpoint, never summed, never sorted
  on together**, and each non-zero figure a link to that list narrowed to the job (`?projectId=`) at
  the same scope, so a column cannot say what its list does not. Their links are named *Exposure on
  260117: 2*, never in the tiles' words, so a tile stays the one link that says what a whole list
  counts. **Open issues carries no count on this screen** — ADR-0016's third figure. A list on the
  desk **folds its secondary columns into its first cell below `sm`** rather than scrolling sideways
  inside a 390 px screen: document width alone does not catch a table that scrolls in its own box.
- The **desk screens are built to plates D-01…D-04** (issue #120, ADR-0059 point 3). Two
  things there are decisions rather than layout. **Everything but *Open items* on the project
  record is a disclosure carrying its count**, which is what takes the page from 4 479 px to
  1 314 px — the plate draws one open section and a stack of collapsed ones, and a deterministic
  rule is what makes the length a number rather than a function of the job. And **density rule
  4 is a query parameter**: resolving an open item on the project record lands back on it
  carrying `?kept=<id>`, which lifts that row out of *Resolved* and shows it where it was with
  its undo, for exactly one load. Nothing is stored, a reload shows the plain filing, and an id
  naming something unresolved keeps nothing. The screen cannot work it out for itself — a
  server action revalidates and re-renders, and *which row just changed* is a fact only the
  caller holds — so `resolveOpenItem` takes a `keepAt`, and the project record is the only
  caller that passes one, being the only screen that files a resolved item somewhere else.
  **The disposition form is the one desk form not behind a disclosure**: bar 4 asks for one
  submit with its two required inputs visible at once, and density rule 1 is about a form that
  *adds to* a record.
- The morning screen, the two lists it drills through to and the pending items view default
  to **mine**, with `app/scope.tsx`'s one toggle to *ours* (issue #112, ADR-0055 part 5).
  **The default lives here and not in the API**: each of the three routes means every job's
  and each takes `?mine=true`, and which rows an engineer is shown first is a question about
  a screen — ADR-0038's no-endpoint rule applied to a filter, not to a payload. Both cards
  drill through carrying the toggle, so a count and the list it lands on cannot answer
  different questions, and the pending screen's GET form carries it in a hidden field,
  because a GET form replaces the whole query string and filtering would otherwise widen
  back to *ours*. Two `<Link>`s and not a control: each half is a URL to bookmark or send.
- The **theme class is written on `<html>` by the server** and never by a client hook (issue
  #117). The root layout reads the session on every request already, so the theme is known
  before the first byte: no flash of the other theme, no `suppressHydrationWarning`, no
  hydration mismatch. It is ADR-0028's rule reaching the one element React never re-renders
  cheaply. **`SYSTEM` is no class at all** — it is the absence of an override, which leaves
  `color-scheme: light dark` in `globals.css` to let `prefers-color-scheme` answer, so do not
  "fix" it by writing a `system` class. The palette is `light-dark(light, dark)`, one
  declaration a token, rather than a `.dark` block duplicated under a media query: both ways
  into the theme then reach the same values with no second copy to drift, and the
  `@custom-variant dark` carries both branches so a `dark:` utility follows. `color-scheme` is
  load-bearing — without it the browser paints this product's native selects as light widgets
  on a dark page. The nav control is **three submit buttons**, not a dropdown: every other
  closed vocabulary here is the native select element, but those are fields inside a form that
  serialises something else, and this one is the whole form.
- Every select added for a person is the **native** element (ADR-0025), for the reason every
  other one here is: the walk's conducted-by, the open item's hand-on, the handoff fieldset's
  "if it is ours, whose", and the extraction confirmation's — which is the one field on that
  screen with nothing proposed behind it, since an extraction proposes a party.
- **Every screen carries the design system's own parts** (issue #118 for the field, #120 for
  the desk; ADR-0059 point 3): `app/section-head.tsx` is the brief's *Section* type step —
  12/16 uppercase with a rule under and the count pushed to the end — and `app/disclosure.tsx`
  is density rule 1's native `<details>`, so the `<form>` inside is untouched, which is 0025's
  rule reaching a container. **`text-lg` has left the product entirely**, which is what those
  two replaced; `desk-screens.test.tsx` sweeps every product source for it, having superseded
  the field-scoped list `walk-screen.test.tsx` carried while 30 heads were still on the desk.
  The `Disclosure` summary is **44 px everywhere**, field and desk alike: density rule 6 is a
  floor (≥ 44 field, ≥ 32 desk) and one component with one height is one fewer number to keep
  in step, where the two **select** heights below are a rule and not an accident.
- **Two select heights and they are two numbers, not two designs**: `selectClassName` is 32 px
  and `fieldSelectClassName` 44 px (`app/native-select.ts`), which is density rule 6 — field
  targets ≥ 44 px, desk ≥ 32 px. `native-selects.test.tsx` sweeps for **both** names, so a
  `<select>` still has to carry one of them. Do not raise the desk one to 44 px to make them
  agree: the asymmetry is the rule.
- The **record measure** is applied by the screen and not by the layout: `<main>` stays
  `max-w-5xl`, the desk measure, and a record screen wraps its own content in
  `max-w-[var(--measure-record)]`. Both tokens were declared inert by issue #117; the walk was
  the first consumer and issue #120 added the register entry, the submission and the finding.
  A screen that used neither would silently be desk-width. **The project record uses both** —
  its head and its two count strips at desk width, its sections at the record's — and it is the
  only screen in the product that does. The **extraction confirmation stays desk-width** though
  the brief's list names it: it is the proposal beside the source in `lg:grid-cols-2`, which
  704 px collapses to one column at every width.
- The walk's **jumper is plain anchors**, sticky at 44 px, and each anchor is a 44 px target
  in its own right rather than a line of text inside a tall bar. `overflow-x-auto` and not
  wrapping: five anchors do not fit across a 390 px phone and a two-row bar is not a 44 px
  bar. Every section it names carries the matching `id` and `scroll-mt-14`, and
  `walk-screen.test.tsx` asserts the anchors and the ids agree — an anchor whose target was
  renamed scrolls nowhere and renders perfectly.
- The **project record carries the conversation panel** since issue #121 (ADR-0058 part 4,
  plate D-02): a `<section>`, open, because a chat behind a summary is a chat nobody opens —
  and since issue #164 the **last** thing on the record, not the second: the author's call
  against the plate, because a conversation grows for as long as the job runs and second on the
  page it buried the record. On a project its turns are a **capped list that scrolls**
  (`max-h-[28rem]`), opened at the newest by `flex-col-reverse` rather than a script, so the
  panel stays a server component; the walk's is uncapped, a separate question. It is the **same component** the walk has and the brief's
  *"one component, two contexts"* held — see `.claude/rules/conversations.md` for what is a
  prop and what is read off the turn. Measured at 390 px on job 260117 on 2026-09-20: the
  document stays 390 px, and the panel costs **+261 px** idle, **+363 px** carrying a
  question and **+1 224 px** with a live proposal open. The record read 1 831 px without it
  on those rows, so it is past plate D-02's ≤ 1 800 closed target **before** this section —
  the job grew since #120's 1 314 px, which was measured on the rows of that morning. Those
  figures predate #164's cap: a long conversation no longer adds its full height.
- The **app shell is a sidebar at the desk and one bar on a phone** since issue #171 (ADR-0069 D2),
  replacing #120's wrapping two-row header. `app/app-shell.tsx`: at `lg` a fixed 256 px `aside`
  (search, the nav in two groups, the **live jobs**, the theme control and the person); below it a
  56 px top bar — the mark, a search link, and a *Menu* that is a native `<details>` with 44 px
  targets. Exactly one is displayed, so one is in the accessibility tree. **The top bar is not
  sticky**: the walk's jumper is the sticky bar on a phone, and two would stack. **Signed out there
  is no nav**, only the mark, and the layout asks the API for no jobs. The **active state** is
  `app/nav-link.tsx`, a client component because the root layout is never handed the path;
  `usePathname` answers in the server render, so the first paint marks the right item. The phone
  menu's one effect **closes it on a path change** — the layout stays mounted across a client
  navigation, so an open `<details>` would otherwise sit over the next screen. The rule #120 set
  still holds and is measured, not asserted: **every screen's document is 390 px wide at 390 px.**
- **The project record is a title block, two tiles, a jumper, a rail and section cards** since issue
  #175 (ADR-0069 D3). **Two tiles and never four**: an open-items or issues tile is ADR-0016's third
  figure, and the two stay **gated on being non-empty** (the asymmetry above). The **rail** is 320 px
  beside the record at `xl` and folds above it below that, first in the source; it is `<div>`s and not
  `<section>`s, because the tests read the first `<section>` as *Open items* and the record column's
  last child as the conversation. **`Disclosure` is the section card**: `icon`, `count`, `detail` and
  `state` are optional, a creation form passes none, and the title sits in `[data-slot="title"]`,
  which is what `summaries()` in `desk-screens.test.tsx` reads. A card's line is **read off what the
  page already fetched**, never a query of its own. The jumper's anchors are asserted against real ids.
  A legend badge on a **tinted** row, or standing for the blue on the dark sheet, takes `/12` in dark
  and not `/20` (4.19:1 and 4.96:1 measured); the green and red `/20` pass as they are.
- **The screen-reader bar is WCAG 2.2 AA on every screen** (issue #158, ADR-0068): VoiceOver
  on an iPhone for the walk, NVDA with Chrome at the desk. `scripts/a11y.mjs` is the automated
  half of its audit — axe-core over `contrast.mjs`'s `SCREENS` at 390 px and 1,280 px, axe's
  source handed in by the driver and not a dependency — and the listening half is a person's,
  against the checklist in the vault's `docs/accessibility-audit.md`. A **new screen goes into
  `SCREENS`**, which is what puts it under both audits. Three rules it turned up, each held by a
  test: an **id rendered twice on one screen takes a `useId` prefix** (the register entry's
  handoff fields did not, and every label named the first form's field); a name on a container
  needs a **role that takes one** (`role="group"` on the mine/ours toggle); and a region that
  **scrolls is focusable and named** (`tabIndex={0}`, `role="region"`, an `aria-label` — the
  project chat's list from #164).
- **Colour is a legend and it is closed** (ADR-0069, issue #169). One blueprint blue is the action
  colour — `primary`, links, focus (`--ring` and `--info` are `var(--primary)`). Four hues each mean
  one thing: `destructive` late, over or standing on something unresolved; `warning` ours to move and
  not yet late; `success` settled; `info` informational or the agent's proposal. Each is ink on its
  own `/10` tint (`/20` in dark) — `Badge`'s variants of the same names — and **never shown without a
  word or a glyph**. A fifth meaning, or a hue as decoration, is a change to ADR-0069, and
  `theme.test.tsx` fails on any Tailwind palette colour in product code, with no exceptions. The page is
  a tinted canvas (`--background`) and content sits on the sheet (`--card`): **a bordered container
  takes `bg-card`**, or it reads as a grey hole in the page; a dashed empty state stays transparent.

