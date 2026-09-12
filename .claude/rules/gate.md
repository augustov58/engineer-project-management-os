---
paths:
  - "apps/api/src/gate.ts"
  - "apps/api/src/passwords.ts"
  - "apps/api/src/users.ts"
  - "apps/api/src/user-command.ts"
  - "apps/api/src/routes/sessions.ts"
  - "apps/api/src/routes/users.ts"
  - "apps/api/src/server.ts"
  - "apps/api/src/index.ts"
  - "apps/api/src/agent.ts"
  - "apps/api/test/gate.test.ts"
  - "apps/api/test/sessions.test.ts"
  - "apps/api/test/users.test.ts"
  - "apps/api/test/harness.ts"
  - "apps/web/proxy.ts"
  - "apps/web/next.config.ts"
  - "apps/web/app/api.ts"
  - "apps/web/app/session.ts"
  - "apps/web/app/sign-in/**"
  - "apps/web/app/users/**"
---
# The gate: users, sessions and the one door

Was `edge-gate.md` until 2026-09-12, when issue #105 replaced the shared secret with users
and sessions (ADR-0055, superseding ADR-0012 and ADR-0020). Every bullet below that predates
that change says so where it still holds. Claude Code loads this file when a path in the
frontmatter is read through the Read tool; from the shell, read it yourself. The rules that
apply to every path stay in `AGENTS.md`.

- The **gate** is a session belonging to a person, and the whole of this deployment's
  access control (ADR-0055). A `users` row is a person; a `sessions` row is one signed-in
  browser or one agent run, revocable on its own — which is the property the shared secret
  it replaced never had. **No environment variable configures any of it**: there is nothing
  to rotate by redeploying, and a deployment with no accounts is one nobody can sign in to,
  which is the closed state reached without a variable to forget.
- The engineer's presentation is a **cookie** and the API's is the `x-session-id`
  **header**, and that is not two mechanisms for one fact. A cookie is how a *browser*
  carries a credential, and no browser reaches the API — every call is made by the Next
  server, which is why ADR-0032 refused a presigned URL. A cookie reader in `apps/api`
  would be machinery for a caller that does not exist.
- `POST /v1/ingest/inbound-mail` is the **one** exempt route, kept by name from ADR-0020 —
  inbound mail can present nothing, so the address's unguessability and its rate limit
  stand in the gate's place (ADR-0042). `GET /v1/health` is **gated**, deliberately: a
  deployment's HTTP check must send a session or be a TCP check, because one named
  exception is a property a test can hold and two is the start of a list. Do not add a
  second.
- `POST /v1/sessions` is **where a session is obtained, not a second exemption**. It
  presents an email and a password instead of a session id and authenticates its own
  caller, and it refuses a wrong password, an unknown address, a disabled account and a
  request with no body at all with the **same 401 the gate answers** — so the sweep still
  reads the ingest webhook as the one route an anonymous caller gets anything else from.
  That is why it is the one route in the product with **no body schema**: a schema answers
  a bodyless POST with a 400, which would break that property and would let a stranger
  learn the request's shape by probing.
- **`apiFetch` in `apps/web/app/api.ts` is the only thing that reaches the API**, because
  it is the only place the session is attached. `apiPath` returns a **path and not a URL**
  so that a second door cannot be built out of it by accident. This is not style: the
  credential was first spelled at each of twenty-five call sites, one was missed, and the
  processing-location screen answered 401 with nothing in the suite to catch it. Do not add
  a `fetch` to the API anywhere else. `next/headers` is imported **inside** `apiFetch`
  rather than at the top of that file, and that is forced: client components read the
  closed vocabularies of a record from the same module, and a top-level import puts a
  server-only module in the browser's graph, which Turbopack refuses to build.
- A 401 sends the engineer to `/sign-in` **only when a session was actually presented**.
  A 401 with none is the sign-in route answering a wrong password, and redirecting there
  would swallow the sentence the form is about to show. The two readers that must be able
  to hear *nobody* — the sign-in call and the header's read of who is signed in — pass
  `refusal: 'answer'`; the header's read is on the sign-in screen too, and would otherwise
  redirect to the page it is already on, forever.
- `apps/web/proxy.ts` and **not** `middleware.ts`: Next 16 deprecated that file convention
  and renamed it. Its matcher excludes only `_next/static`, `_next/image` and `favicon.ico`;
  `/sign-in` is exempted **inside the function and never in the matcher**, because a server
  action is a POST to the route it is used on, so a matcher exclusion silently un-gates that
  route's actions too. A page navigation without the cookie is redirected to `/sign-in`;
  everything else is refused **where it stands** with a 401, because an `EventSource` follows
  a redirect into an HTML page and then reconnects forever without showing anybody an error.
  What the proxy can decide without a database is whether there is a cookie at all; whether
  it is still a session is the API's answer, on every request.
- The agent's domain tools present a **run-scoped session** — `caller(apiBaseUrl,
  sessionId)` in `agent.ts` calls the API over loopback HTTP, and loopback is not an
  exemption. The session is minted by the route that creates the run, in the name of
  whoever asked for it, and revoked by the worker when the run settles. It is found through
  `sessions.agent_run_id` or `sessions.extraction_id` rather than carried in the job
  payload: a queue payload is a place a live credential would sit, readable and outliving a
  stalled job. This product has **two** run records, which is why there are two link
  columns and a CHECK that at most one is set. `underRunSession` in `gate.ts` is the one
  place the lookup and the revoke live, with the revoke in a `finally` — "expiring when the
  run ends" is a fact about that function rather than about two handlers both remembering.
- The first account is a **command on the machine** (`pnpm --filter api user create`,
  `scripts/user.sh` on Fly) and every one after it is `POST /v1/users` by somebody already
  signed in — an audited mutation like any other. `user reset <email>` sets any password and
  revokes that person's live sessions in the same transaction, because a password changed
  because it may be known is not changed at all while the browser that knew it stays signed
  in. **No roles**; the named trigger that
  would add one is the first time an engineer must be *prevented* from doing something
  rather than *recorded* doing it. The password is never an argument: argv is in the
  shell's history and in `ps`.
- `POST /v1/users/:id/disable` stamps `disabled_at` and revokes every live session of that
  account in one transaction, so "cannot sign in" is true of the phone in somebody's pocket
  and not only of the sign-in screen. It is **not a one-way door**: anybody may close any
  account including the last one, and `pnpm --filter api user enable <email>` is the floor
  under that — the same floor the first account falls through. Re-opening does not restore
  the revoked sessions; signing in again is the way on.
- `proxy.ts` and the open-redirect guard are covered by `apps/web/test/proxy.test.ts`,
  which is new in issue #105 and closes a hole that predated it: neither had a test, and a
  regression in either was invisible to `pnpm test`. Both were verified by breaking them on
  purpose — an empty cookie let past, and the guard returning its argument — and each failed
  exactly the assertion written for it.
- The gate test is **exhaustive and not representative**. `startTestApi` collects every route
  Fastify registers through an `onRoute` hook and exposes them as `routes()`; `gate.test.ts`
  walks every one of them and asserts the allowed set is exactly the ingest webhook — no
  count is written down, since the number is whatever the API currently registers. A route
  added in a later slice is covered without anybody remembering. Do not narrow that sweep to
  a sample.
- The harness writes its user and session rows **directly**, and that is the bootstrap
  rather than an exception to "fixtures through the API": on a real deployment the first
  account is made before anything can sign in. It writes no audit line, because
  `export.test.ts` asserts an untouched database has nothing in `audit_entries`, and its
  session outlives any clock a test advances — a dozen suites age a fake `TimeSource` by up
  to four hundred days, and a fixture that expired under them would turn every one of those
  into a 401 about the wrong thing. What a real session's life is worth is asserted against
  one the sign-in route minted.
