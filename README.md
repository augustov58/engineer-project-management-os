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

The gap is real, and slice 2 hit it: `apps/web` resolves modules the bundler way while
`apps/api` uses NodeNext, so relative imports written `./api.js` typechecked clean and
then 500'd in Turbopack. **Web imports carry no file extension; API imports carry `.js`.**
Until there is a web test, run the app and load the pages before calling a frontend change
done.

Since ADR-0025 the frontend also compiles a stylesheet, which `pnpm typecheck` does not
check. `pnpm --filter web build` is the command that catches a Tailwind or PostCSS error;
it also works when `pnpm dev` will not, which on a machine that has run out of inotify
watches is the difference between verifying a change and not.
