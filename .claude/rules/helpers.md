---
paths:
  - "apps/api/src/helpers.ts"
  - "apps/api/src/routes/tools.ts"
  - "apps/api/test/tools.test.ts"
  - "apps/api/test/helper-fixtures/**"
  - "apps/api/tools/**"
  - "scripts/helper-tests.sh"
---
# The helper registry, the manifests and the one route

Written for issue #107 (ADR-0053, corrected 2026-09-11), the first of these files not moved
out of `AGENTS.md` on 2026-09-01. Claude Code loads this file when a path in the frontmatter
is read through the Read tool; from the shell, read it yourself. The rules that apply to
every path stay in `AGENTS.md`.

- A **helper skill** is a directory, and adding one is adding a directory. It lives in the
  helpers' own repository, pinned by commit as a git submodule at `apps/api/tools/` — the
  author's framework, which outlives any one employer, so it is not vendored into this
  repository and not edited here. `git submodule update --init` after a clone, and moving
  the pin is its own commit with its own reason. The glossary's word is **helper skill** or
  **helper**; `_Avoid_: calculator, engine, module` binds identifiers as much as UI copy,
  whatever the ADRs' prose calls them.
- **A directory carrying a `manifest.json` is registered, and one without is not.** That is
  the whole of the registry, and it is how `generator-sizing` ships in the pin and stays out:
  it prints a JSON dict and a summary rather than the two blocks, and has no `argparse` at
  all. It is registered the day it prints them, which is work in the helpers' repository.
  Nothing in `apps/api` names a helper — not the route, not the tool list — so do not add a
  list of them anywhere. The **one** exception is in `scripts/helper-tests.sh`, which names
  `short-circuit` and `voltage-drop` to diff their two script trees; that check is about a
  pair and cannot be derived from the directories without reading the very property it is
  checking. A third copy names itself there or is not checked.
- The manifest's six fields are all required and all read at runtime: `name` (which must
  equal the directory, so the path segment cannot drift from what is on disk), `computes`
  (the sentence the agent reads as the tool description), `entry`, `arguments.passing`,
  `arguments.schema`, `record` and `test`. `passing` and `record` each have exactly one
  implemented value — `flags` and `blocks` — and a manifest naming anything else is
  **unregistered with a sentence** rather than silently dropped or half-run. That is what
  keeps the fields live rather than dead config: the day a helper takes a JSON file, the
  refusal is what says the runner has to learn how.
- `helpers.ts` is a **leaf** (ADR-0033) and was one from its first line, as `zone.ts` was:
  `routes/tools.ts` runs a helper and `agent.ts` generates the tool list, so it had two
  readers before it had one. It imports no route module.
- **The route records nothing** — no row, no stamp, no audit line. Asking a helper and
  recording what it said are two acts, and the recording is still
  `POST /v1/assumption-records` against a submission (ADR-0029). `POST /v1/tools/:name` is
  therefore the **one** mutating-method route `test/audit.test.ts` exempts, in a
  `RECORDS_NOTHING` set with one member. One named exception is a property a test can hold
  and two is the start of a list — the argument `gate.md` makes for the ingest webhook. A
  second entry needs an ADR, not a line. It answers **200 and never 201**: there is no
  location, because there is nothing there.
- The route is **gated like every other** and `gate.test.ts` proves it without a line
  changing, which is ADR-0053's reason for a helper being a route of ours at all. Verified
  by breaking it on purpose: adding the route to the gate's `EXEMPT` set fails that sweep.
- **The two blocks come back verbatim.** They are found by their two header lines and by the
  rule of `=` the helpers close a report with; nothing reads a line's content, and the `- `
  and `! ` sigils stay unparsed for the reason ADR-0029 gives. Nothing trims, normalises or
  re-wraps, so the two leading spaces survive to the caller. A registered helper that prints
  neither header is **broken**, answering 502 — not a record with empty blocks.
- **The subprocess is given its own directory, and that is not a jail.** It runs with the
  helper's directory as its working directory, an environment carrying nothing but `PATH`,
  no shell, `python3 -B -I`, and an argv built only out of values the manifest's own schema
  accepted — so no path reaches it that it did not ship with, and none can be injected. It
  is **not** a `chroot`, a mount namespace or a container, and nothing here claims one:
  ADR-0041's rule is that a sandbox claimed for code you did not write is not a sandbox
  until the mechanism has been read, and saying plainly what this is costs less than an
  unverified word. What stands behind it is that the code is ours and pinned.
- A property becomes a flag by one rule and only one: `perPhase` → `--per-phase`. A `true`
  boolean is the bare flag, a `false` one is **no flag at all**, because these map to
  argparse `store_true` actions that take no value. A manifest naming a property the script
  does not take makes argparse exit 2, and that reaches the caller as the script's own
  sentence — which is the right answer and not a 500.
- **The schema validates what this product can know and no more.** "Exactly one of these
  four" is argparse's rule, not ours: the manifests express "at least one" and let the
  script refuse the rest, so a nonzero exit carrying stderr is a **400** and a designed path
  rather than an accident. Its own `Ajv`, configured unlike the boundary's on purpose —
  `coerceTypes` off, because `"40"` is not `40` here, and `useDefaults` off, because an
  omitted flag is how a script's own default is asked for.
- The wall-clock limit is **ten seconds**, `WALL_CLOCK_MS` in `helpers.ts`, written down in
  one place because ADR-0053 requires a limit and never names one. A run still going is
  killed and answers 504.
- `scripts/helper-tests.sh` is the **fifth CI gate** and runs each manifest's own `test`
  from that helper's directory. It gates what this repository *pinned*, where the other four
  gate what it wrote: a bad commit moved into the submodule is a wrong number on a drawing,
  not a red typecheck. It carries a vacuity guard — under three commands is a failure, since
  a submodule that did not check out would otherwise run nothing and exit 0.
- `short-circuit/` and `voltage-drop/` carry **byte-identical copies** of one SPD script set,
  because a helper is a directory and each is what its subprocess is given. The 40-case
  handbook harness runs in both, and the gate diffs the two trees, so a drift that changes an
  answer and a drift that does not each fail. Edit one, copy it across, let the harness say
  they agree.
- **`tools.test.ts` drives four things directly, and that is a second exception to
  `api.md`'s test policy** — `readHelpers` and `runHelper` against `test/helper-fixtures/`,
  and the pure `blocksOf` and `argvFor`. Written down here because api.md names exactly one
  sanctioned exception (`schema.test.ts` reading `information_schema`) and an undocumented
  hole in a rule is worse than a documented one. What licenses it: a fixture helper is not in
  the deployment's registry and cannot be reached through any route, and a timeout driven
  through HTTP costs ten seconds of suite time to assert a number written in one place. The
  rule still binds everything reachable — every refusal, every block, the audit and the
  export are asserted through `app.fetch` against a real database, and the precedent for
  calling a tool-list builder directly is `extractions.test.ts`'s. Do not widen this.
- `helperTools` in `agent.ts` is generated from the same manifests and **is not yet given to
  a run**. Neither run this product has may call a helper: ADR-0040 fixes the memory run's
  read set and ADR-0043 gives the extraction run exactly one tool. The run that asks is the
  project conversation (ADR-0058), which is its own ticket. Tool names are the directory
  names **underscored**, because provider APIs reject a dot (ADR-0040); the route's path
  segment keeps the hyphens.
