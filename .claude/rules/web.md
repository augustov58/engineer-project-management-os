---
paths:
  - "apps/web/**"
---
# Rules for `apps/web`

Ground rules moved out of `AGENTS.md` on 2026-09-01, none rewritten. Claude Code loads this file when a
path in the frontmatter is read through the Read tool; from the shell, read it yourself. The rules that
apply to every path stay in `AGENTS.md`.

- The frontend is Tailwind + shadcn/ui, components owned in `apps/web/components/ui` (ADR-0025). Where a styled component would change how a control serialises into a form, keep the native element and style it. The nobody checkbox, the pending sort select, the submission phase select, the attach-an-open-item select (on a submission and on an issue), the observation's Side/Sector axis select, the finding's category select and the select that makes a sighting another sighting of a finding already on the register are all native for that reason; `apps/web/app/native-select.ts` holds the shared styling.
- `pnpm typecheck` does not compile the stylesheet and `pnpm test` does not run the frontend — `apps/web` has no test script at all, which is issue #50. Run `pnpm --filter web build` and load the pages before calling a frontend change done. That build needs a **generated** `EDGE_SECRET` — run it as `EDGE_SECRET=$(head -c 32 /dev/urandom | base64) pnpm --filter web build`, or it stops at config load under a `Failed to load next.config.ts` headline that reads like a syntax error and is not one (README has the why). That build rewrites the tracked `apps/web/next-env.d.ts` to its production paths and `next dev` rewrites it back — leave it out of the commit either way. Browse `http://localhost:3000`, not `127.0.0.1`: Next's dev-origin guard 403s the client chunks on the other host, so the page renders and silently never hydrates.
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
