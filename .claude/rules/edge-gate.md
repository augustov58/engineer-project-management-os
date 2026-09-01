---
paths:
  - "apps/api/src/edge-gate.ts"
  - "apps/api/src/server.ts"
  - "apps/api/src/index.ts"
  - "apps/api/src/agent.ts"
  - "apps/api/test/edge-gate.test.ts"
  - "apps/api/test/harness.ts"
  - "apps/web/proxy.ts"
  - "apps/web/next.config.ts"
  - "apps/web/app/api.ts"
  - "apps/web/app/edge-secret.ts"
  - "apps/web/app/unlock/**"
---
# The edge gate

Ground rules moved out of `AGENTS.md` on 2026-09-01, none rewritten. Claude Code loads this file when a
path in the frontmatter is read through the Read tool; from the shell, read it yourself. The rules that
apply to every path stay in `AGENTS.md`.

- The **edge gate** is one long-lived shared secret in front of every route, and the whole of
  this deployment's access control (ADR-0020). ADR-0012 removed *identity*; it did not remove
  access control, and this adds no `users`, `roles` or `permissions` table. There is no
  session and nothing stored, so rotating the secret is a redeploy. `EDGE_SECRET` is
  **required with no default** in both apps — `buildServer` takes `edgeSecret: string` the
  way it takes `objectStore`, `apps/api` guards it with the same `requireEnv` as
  `DATABASE_URL`, and `apps/web` throws in `next.config.ts`, the only thing Next loads before
  it serves. Never a `NEXT_PUBLIC_` name: that prefix inlines a value into every client bundle.
- The engineer's presentation is a **cookie** and the API's is the `x-edge-secret` **header**,
  and that is not two mechanisms for one fact (ADR-0020). A cookie is how a *browser* carries
  a credential, and no browser reaches the API — every call is made by the Next server, which
  is why ADR-0032 refused a presigned URL. A cookie reader in `apps/api` would be machinery
  for a caller that does not exist. Both sides compare `timingSafeEqual` over SHA-256 digests,
  so neither the comparison nor a length mismatch is a side channel.
- `apps/web/proxy.ts` and **not** `middleware.ts`: Next 16 deprecated that file convention and
  renamed it. Its matcher excludes only `_next/static`, `_next/image` and `favicon.ico`;
  `/unlock` is exempted **inside the function and never in the matcher**, because a server
  action is a POST to the route it is used on, so a matcher exclusion silently un-gates that
  route's actions too. A page navigation without the cookie is redirected to `/unlock`;
  everything else is refused **where it stands** with a 401, because an `EventSource` follows
  a redirect into an HTML page and then reconnects forever without showing anybody an error.
- `POST /v1/ingest/inbound-mail` is the **one** exempt route and the only one ADR-0020 carves
  out — inbound mail can present nothing, so the address's unguessability and its rate limit
  stand in the gate's place (ADR-0042). `GET /v1/health` is **gated**, deliberately: a
  deployment's HTTP check must send the header or be a TCP check, because one named exception
  is a property a test can hold and two is the start of a list. Do not add a second.
- **`apiFetch` in `apps/web/app/api.ts` is the only thing that reaches the API**, because it
  is the only place the secret is attached (ADR-0020). `apiPath` returns a **path and not a
  URL** so that a second door cannot be built out of it by accident. This is not style: the
  secret was first spelled at each of twenty-five call sites, one was missed, and the
  processing-location screen answered 401 with nothing in the suite to catch it — `apps/web`
  has no tests, so construction is the only guarantee there is. Do not add a `fetch` to the
  API anywhere else.
- The agent's domain tools present the secret like any other caller: `caller(apiBaseUrl,
  edgeSecret)` in `agent.ts` calls the API over loopback HTTP, and loopback is not an
  exemption. `fakeAgentRunService` sends it too — `app.inject` runs the whole lifecycle, hooks
  included.
- The gate test is **exhaustive and not representative**. `startTestApi` collects every route
  Fastify registers through an `onRoute` hook and exposes them as `routes()`; `edge-gate.test.ts`
  walks every one of them and asserts the allowed set is exactly the ingest webhook — no count
  is written down, since the number is whatever the API currently registers. A route added in a
  later slice is covered without anybody remembering. Do not narrow that sweep to a sample.
