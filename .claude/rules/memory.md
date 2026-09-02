---
paths:
  - "apps/api/src/routes/memory.ts"
  - "apps/api/src/agent.ts"
  - "apps/api/src/worker.ts"
  - "apps/api/test/memory.test.ts"
  - "apps/api/prisma/schema.prisma"
  - "apps/web/app/memory.tsx"
  - "apps/web/app/memory-diff.ts"
  - "apps/web/app/live-list.ts"
  - "apps/web/app/projects/*/memory/**"
  - "apps/web/app/projects/*/page.tsx"
---
# Project memory, proposals, agent runs and the audit

Ground rules moved out of `AGENTS.md` on 2026-09-01, none rewritten. Claude Code loads this file when a
path in the frontmatter is read through the Read tool; from the shell, read it yourself. The rules that
apply to every path stay in `AGENTS.md`.

- A project's **memory** is `project_memory_versions` with **no identity table** — the project is the identity, since there is exactly one memory per job (ADR-0040). Nothing edits or deletes a version; the current memory is the latest, derived on every read. The size budget (4,000 characters) rides on every read and is **surfaced, never enforced**.
- A **proposal** is the approval request — the sketch's `approval_requests` table is refused. Its `base_content` is **snapshotted when the proposal is written**, so the diff under review cannot drift as memory moves; and the proposal is never edited — accept-with-edit writes the *version* from the engineer's text and keeps the agent's words on the proposal. The agent's one mutating tool writes proposals only; there is no accept tool, which is what "the agent never writes memory directly" is made of.
- Accepting a proposal whose `base_content` is no longer what the memory says is **refused**, never re-diffed (issue #42, recorded in ADR-0040). The snapshot stands: re-drawing the diff against today's memory would put text under review that the agent did not propose, and would leave an engineer's *edited* text — written line by line against the old base — meaning something nobody chose. The way on is reject and ask again. `stale` is derived on every read from the memory's current **content** against the base and stored nowhere, so a memory written back to what the base said is honest again; only a pending proposal is ever stale. The check runs inside the accept's transaction. The screen withholds Accept and says why, because a diff that misdescribes the commit it is offering is the defect, not the refusal.
- A proposal is answered **once**, and the database holds it (issue #42). Both routes settle the row by compare-and-set — the stamps in the `where`, the count checked — **first** in their transaction, so the audit row rolls back with the update it describes; a CHECK stands behind them. The pending read above each is not a bound: a concurrent accept and reject each passed it and each committed, leaving both stamps set, the wire reporting `accepted`, and an append-only audit carrying both answers. The accept route's `project_memory_versions.proposal_id` unique is untouched and still catches the race the version insert loses.
- `project_memory_versions.seq` is the **tie-break and nothing else** — never an identifier, never on the wire, not a count (issue #42). "The current memory is the latest" ordered on `created_at` then `id`, and `id` is a random v4 uuid while `created_at` is `TIMESTAMP(3)`, so two versions written in the same millisecond ordered by coin toss and the older could read as current. Which version is current is read in **one place**, `currentVersion` — the memory read, the proposal's base and the accept's staleness check all come through it, and `readMemory` counts rather than loading every version and taking its last, because a second way to work out which row is current is a second thing that can be wrong about it. The history's order is that one **reversed** and must stay its exact reverse; a test writes five versions in one millisecond and asserts both readings agree.
- An **agent run** is a row with the four stamps and no `kind` column, produces at most one proposal (`run_id` unique), and has **no retry route** — asking again is another row (ADR-0035's reason). The worker dispatches a third job name, `propose-memory-edit`, on the same queue.
- `AgentRunService` is the port ADR-0002 requires and **no Pi type appears outside `agent.ts`** — the SDK is imported lazily so a test process never loads it. The default refuses with "no model provider is configured"; `AGENT=pi` builds the real adapter. The domain tools call the internal API over HTTP and never the database, are registered with **underscored names** (provider APIs reject the PRD's dotted spelling), and the session's tool list is an **allowlist** naming this product's domain tools and nothing else, so every built-in is absent rather than denied — the file tools `read`, `grep`, `find` and `ls` included. They were kept in slice 17 and described as scoped by `cwd`; the SDK's `resolvePath` uses `cwd` only as the base for a *relative* path, returns an absolute one as given and expands `~`, with no containment check in any of the four, so `cwd` never bounded them and a run could read the SDK's own credential store. A memory run reads no file, so they were removed rather than fenced (ADR-0041). Do not re-enable one without reading the vendor's resolver first.
- Every memory mutation writes an `audit_entries` row **in the same transaction**, and nothing updates or deletes one — append-only by construction. The audit is scoped to memory; widening it to every record's mutations is its own change.
- The memory screen's stream carries both lists (`{runs, proposals}`) and `useLiveList` is generic over the payload since this slice; the `sseFrames` test helper moved into the harness when `memory.test.ts` became the second reader of a stream.
- **The agent is never given the ingest address.** `projectOnTheWire` carries it, and
  `projects_get` in `agent.ts` had handed the project read through verbatim — so the
  credential would have reached a model provider, the proposal and the audit. That tool now
  returns the three fields its description names. A test asserts it and fails without the
  projection. Anything else a project grows is covered by the same shape; do not go back to
  passing the response through.
