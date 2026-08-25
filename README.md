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

## What slice 1 fixed, so later work does not re-decide it

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

Not covered by tests in this slice: the frontend. `apps/web` has no test script, so
`pnpm test` exercises the API only, and a change that breaks the page would not fail the
suite. That is deliberate — the MVP spec's test seam puts the thin browser-driven pass at
step 3 (site visit capture), on top of record-level coverage, rather than here.

`skeleton_records` is disposable — it exists only to prove the path end to end, and should
be dropped once a real record reads through the same route.
