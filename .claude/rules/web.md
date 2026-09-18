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
- `pnpm test` **does** now run the frontend: `apps/web` has a `test` script (Vitest under jsdom, `apps/web/test/`) and the root `pnpm -r test` runs it, which is issue #50 and ADR-0049. What it covers is component-level and no more — that the one door to the API is the only one, that every select is the native element, that a first paint is in the server's render and survives hydration, that the morning screen's two cards render at zero where the project screen's strips do not, and, since issue #105, what `proxy.ts` does with a session cookie and what the sign-in screen's open-redirect guard refuses (`test/proxy.test.ts`; both are plain functions, so neither needs infrastructure the suite did not already have). The guard lives in `app/sign-in/destination.ts` and not in `actions.ts` because a `'use server'` module may export nothing but async server actions, which is what kept it untestable until then. What it does **not** cover is the arrangement production is: the gate end to end, the loopback API, Next serving anything, and hydration in a real browser. `pnpm typecheck` does not compile the stylesheet either. So run `pnpm --filter web build` and load the pages before calling a frontend change done, as before — the suite narrowed that rule and did not lift it. That build **needs nothing passed to it** since issue #105: it wanted a generated `EDGE_SECRET` until `next.config.ts` stopped checking for a shared secret that no longer exists, and it used to stop at config load under a `Failed to load next.config.ts` headline that read like a syntax error and was not one. That build rewrites the tracked `apps/web/next-env.d.ts` to its production paths and `next dev` rewrites it back — leave it out of the commit either way. Browse `http://localhost:3000`, not `127.0.0.1`: Next's dev-origin guard 403s the client chunks on the other host, so the page renders and silently never hydrates.
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
