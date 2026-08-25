# Engineer Project Management OS

Internal operations dashboard for engineering projects, with a Pi-powered copilot.

Planning documentation is authoritative in the Obsidian vault, not here — start with
[CONTEXT.md](./CONTEXT.md), which points at it.

## Requirements

Node 22.12+, pnpm 10, and Docker (PostgreSQL and Redis run in containers; nothing needs
to be installed on the host).

## Running it

```bash
pnpm install
pnpm dev
```

`pnpm dev` copies the `.env.example` files if no `.env` exists yet, starts PostgreSQL and
Redis, applies migrations, and runs both apps: API on <http://127.0.0.1:3001>, frontend on
<http://127.0.0.1:3000>.

Use `localhost`, not `127.0.0.1`, in the browser: `next dev` refuses to serve its own
`/_next/*` assets to an origin it does not recognise, so the page renders and then dies
with a 403 on every script. `apps/web/next.config.ts` adds this machine's own network
addresses to that list, which is what makes the app viewable from another device on the
same network. **Only the frontend is reachable that way** — the API, PostgreSQL and Redis
stay bound to loopback, and nothing breaks because every call to the API is made by the
Next server rather than by the browser. A client-side fetch to `NEXT_PUBLIC_API_URL` would
break that, and would only fail on the second device.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Everything: containers, migrations, API, frontend |
| `pnpm typecheck` | `tsc --noEmit` across both apps |
| `pnpm test` | API test suite — starts its own PostgreSQL and Redis, so nothing needs to be running first |
| `pnpm services:up` / `services:down` | The Docker containers on their own |
| `pnpm --filter api migrate:dev` | Create a migration after editing `schema.prisma` |

## Layout

```
apps/api    Fastify API, Prisma schema and migrations, BullMQ queue
apps/web    Next.js frontend (App Router)
docs/       Agent-facing notes; the ADRs and glossary live in the vault
```

## What earlier slices fixed, so later work does not re-decide it

- **Fastify, not NestJS** (ADR-0021). Dependencies are passed into `buildServer()` as
  arguments; nothing is resolved from a container. Both `src/index.ts` and the test
  harness get theirs from `createRuntime()` in `apps/api/src/runtime.ts`, so tests
  construct the server the way production does by construction, not by two copies of the
  wiring staying in step.
- **`TimeSource`, not `Clock`** (ADR-0022). "Clock" is domain vocabulary here — register
  entries aging in our court — so the wall-clock port is called `TimeSource`. Nothing
  persists a timestamp from `new Date()`, and no aged column carries a database default,
  because either would be unreachable by the fake. Aging is tested by advancing the fake.
- **The test harness.** `apps/api/test/harness.ts` is the pattern every later slice copies:
  an ephemeral PostgreSQL per test run migrated by `prisma migrate deploy` from the same
  migrations production uses, a fresh database copied from it per test, a real listening
  HTTP server, and fixtures built through the API rather than by inserting rows.
- **`/v1` on every route** (ADR-0023). The prefix is one `register` call in
  `apps/api/src/server.ts`, not a string repeated per route. Slice 2 moved `/health` under
  it and dropped `skeleton_records`, so nothing unversioned survives.
- **One column says whether an open item is unresolved** (ADR-0024): `resolved_at` being
  null, with `resolution_note` moving with it. Exposure, provisional state and the pending
  items view are all derived from that column, so none of them can disagree about what
  "unresolved" means. There is no status field, and adding one would create a second
  answer. The subject is polymorphic — `subject_type` is a database enum carrying only
  `PROJECT`, so attaching an open item to a submission is a migration, not a new string.

- **What an issuance rests on is a join, not a subject** (ADR-0026). An open item's
  `subject_type`/`subject_id` says where it lives; `submission_open_items` says which
  issuances depended on it. ADR-0024 expected the other reading — adding `SUBMISSION` to
  the subject enum — and taken literally it breaks the next two slices: attaching an
  existing item would re-point it off the project, and issue #7's "carry forward to the
  reissue" would re-point it off the superseded submission, erasing the record of what the
  original went out on. One item can back several issuances, and a resolved one stays on
  the set it went out with.
- **A phase is a row the submission points at** (ADR-0026), so renaming propagates to
  everything issued at it. That is deliberate: a rename is the same body of work under a
  better name, and a set that went out at a different stage is a different phase.
  **Nothing edits a submission** — the API exposes no route that updates one, which is what
  makes "no path edits an issued submission" true by construction rather than by a guard
  someone can forget. What a set rests on is named in the same call that records it,
  because issue #6 stamps whether it went out on unconfirmed inputs *at the moment of
  issuance*; a two-call flow would leave no such moment and force a rewrite of this slice.

- **Provisional is two facts and the record keeps both** (ADR-0027).
  `submissions.issued_provisional` is stamped at the moment of issuance and never
  recomputed; *currently provisional* is derived on every read from `resolved_at` and
  stored nowhere. Resolving everything a set rested on takes it out of exposure and leaves
  standing the fact that it went out on unconfirmed inputs — one column could not be both,
  because it would start lying about one of them the moment an item resolved.
  `submission_open_items.unresolved_at_issuance` is the per-item snapshot, nullable because
  the null says the item was attached *afterwards*; **detach is narrowed to exactly those
  rows**, which is how cleanup cannot erase what went out.
- **Superseded is a successor existing, not a stored flag** (ADR-0028). A reissue is a new
  submission carrying `supersedes_id`; nothing is written to the row it points at, because
  writing to it is the edit the record type exists to prevent. *Superseded* is therefore
  derived on every read — the shape ADR-0027 gave *currently provisional* — and there is no
  `superseded_at`, the successor's `issued_at` being when the prior set stopped being
  current. `supersedes_id` is **unique**, and that alone is "at most one successor; the
  chain is linear": a second reissue is refused by the database. Cycles cannot arise, since
  a row is created already pointing at an older one and nothing repoints it, which is what
  lets the chain be walked link by link and returned whole from any of them.
- **Carry-forward is the create path with one different default** (ADR-0028). On a reissue,
  `openItemIds` left off carries forward what the superseded set rested on; supplied is
  exactly that list, so `[]` is a deliberate drop rather than an omission. The successor
  stamps its own `unresolved_at_issuance` and `issued_provisional` at its own moment of
  issuance — an item answered in between reads `false` on the reissue and stays `true` on
  the ancestor — and the phase defaults to the superseded set's rather than to wherever the
  job has since got to.
- **Exposure is a list, not a number** (ADR-0027). `GET /v1/exposure` returns the
  submissions themselves, optionally narrowed by `?projectId=`, so every count on every
  screen is that list's length — "clicking the count lands on exactly what it counted" is
  then true by construction rather than by two queries agreeing. A payload that is an array
  also has nothing to combine a second figure with, which is ADR-0016's prohibition made
  structural rather than remembered. Archived projects leave the across-every-project count
  and keep their own, and superseded ancestors leave it entirely (ADR-0028) — carry-forward
  puts the same unresolved item on both, so counting the ancestor too would make the number
  grow by correcting the record.

- **Tailwind and shadcn/ui, owned in-repo** (ADR-0025). Components live in
  `apps/web/components/ui` and are edited in place rather than imported from a versioned
  package, so there is no library upgrade to absorb. Radix underneath means focus rings and
  keyboard behaviour come with the components. Two controls stay deliberately native and
  styled by hand — the "nobody owes the next move" checkbox and the pending-items sort
  select — because a styled component would change how they serialise into a form.

Not covered by tests: the frontend. `apps/web` has no test script, so `pnpm test`
exercises the API only, and a change that breaks the page would not fail the suite. That
is deliberate — the MVP spec's test seam puts the thin browser-driven pass at step 3 (site
visit capture), on top of record-level coverage, rather than here.

Slice 4 hit the gap twice, both invisible to `pnpm test` and to `tsc`: a `<select>` whose
`defaultValue` is only applied at mount, so changing a project's current phase left the
form still showing the old one and the next set would have been recorded at the wrong
stage; and an `<li>` nested inside the `<li>` that `OpenItemEntry` already owns, which is
invalid HTML and failed hydration in the browser console. Both were found by loading the
page, not by a test.

Slice 5 paid for it a third time. The warning that a set is going out on unresolved open
items was first a counter incremented as boxes were ticked, and `key` sits on the `<form>`
while the state sat on the component around it — so recording a submission cleared the
boxes and left the warning claiming the next set carried items nobody had ticked. A code
review caught it; `pnpm typecheck` and `pnpm test` were both green throughout. It is now
read straight off the form, which also fixes the opposite drift (a reload that restores
checked boxes would have shown no warning at all).

Slice 6 paid for it a fourth time, and this one had been latent since slice 5. The warning
above is seeded into state and corrected by a ref callback on the form; a state update made
from a ref during the **hydration** commit is discarded, so the count stayed at its seed.
With nothing ticked at first paint that seed was right by luck, and a reissue — which
arrives with every carried item ticked — showed a page claiming the set rested on nothing
while two checked boxes sat in front of it. The count is now seeded from the props, so the
warning is in the server's HTML and the ref only corrects it afterwards. One trap while
looking for this class of bug: browse `http://localhost:3000`, not `127.0.0.1`, or Next's
dev-origin guard 403s the client chunks and the page renders but never hydrates at all.

The gap is real, and slice 2 hit it: `apps/web` resolves modules the bundler way while
`apps/api` uses NodeNext, so relative imports written `./api.js` typechecked clean and
then 500'd in Turbopack. **Web imports carry no file extension; API imports carry `.js`.**
Until there is a web test, run the app and load the pages before calling a frontend change
done.

Since ADR-0025 the frontend also compiles a stylesheet, which `pnpm typecheck` does not
check. `pnpm --filter web build` is the command that catches a Tailwind or PostCSS error;
it also works when `pnpm dev` will not, which on a machine that has run out of inotify
watches is the difference between verifying a change and not.
