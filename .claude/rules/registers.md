---
paths:
  - "apps/api/src/routes/registers.ts"
  - "apps/api/test/registers.test.ts"
  - "apps/api/prisma/schema.prisma"
  - "apps/web/app/clock/**"
  - "apps/web/app/registers/**"
  - "apps/web/app/register-entries/**"
  - "apps/web/app/register-forms.tsx"
  - "apps/web/app/ball-in-court.tsx"
  - "apps/web/app/projects/*/page.tsx"
---
# Registers, entries, ball-in-court, the clock and dispositions

Ground rules moved out of `AGENTS.md` on 2026-09-01, none rewritten. Claude Code loads this file when a
path in the frontmatter is read through the Read tool; from the shell, read it yourself. The rules that
apply to every path stay in `AGENTS.md`.

- **Ball-in-court is a history and never a field** (ADR-0036). `ball_in_court_events` is one
  row per handoff; *ball-in-court* is the last of them, derived on every read and stored
  nowhere, the shape ADR-0027 gave *currently provisional*. `register_entries` has **no status
  column and no `ball_in_court` column**, and their absence is the test that this has not
  become the transition log ADR-0031 refused — it is here because an arithmetic reads it
  (issue #15 sums the intervals where the ball was ours), which a current value cannot produce
  at all. Do not add either column.
- A handoff carries `party` **and** `in_our_court`, and neither derives from the other
  (ADR-0036). The clock reads the boolean; the screen shows the name. Do not read "ours" off
  the name the way ADR-0024 reserved `nobody` on `waiting_on`: nothing computes from `nobody`,
  and a job that calls us by the firm's name still accrues. Ordered by `held_since` then
  `created_at`, because a transmittal log is written up out of order. Handing the ball to
  whoever already holds it is two intervals and is not refused.
- Both registers are written **in the same transaction as the project** and there is no create
  route and no delete (ADR-0036). `@@unique([project_id, kind])` is what makes "exactly two"
  a fact the database keeps. A register carries no state: it is the scope an entry's number is
  unique within.
- `register_kind` is a **database enum**, deliberately reversing the text-with-a-CHECK run
  (ADR-0036). ADR-0031's reason was that `Physical / Safety` cannot be a Prisma enum member;
  `SUBMITTAL` and `RFI` name themselves, so `open_item_subject` is the live precedent. The
  disposition arriving in issue #15 is text with a CHECK, by that same reasoning.
- A register entry's `number` is the **engineer's and never allocated** — the opposite of an
  issue's identifier (ADR-0031) — and is unique within its register, not within the job. The
  first handoff is named in the same call that logs the entry (ADR-0026's shape), so the
  derived current holder is never nobody. Nothing edits an entry: `PATCH`, `PUT` and `DELETE`
  are 404 and a test asserts it.
- The link to the issuance that responded is `register_entries.submission_id`, **never a column
  on the submission** (ADR-0036). Story 35 reads the same column in reverse; a column on
  `submissions` could only be written after the set went out, which is the update route
  ADR-0026 made impossible by construction. Set once; a second link is refused rather than
  repointed, as a second response is.
- Which kind carries a question is enforced **at the boundary only** (ADR-0036), unlike
  ADR-0030's one-axis rule and ADR-0031's category. The kind lives on `registers` and a CHECK
  cannot read another row; copying it onto the entry would be the second place the same fact
  lives. The one CHECK that is reachable is written: a response without a question is
  impossible.
- An open item on a register entry is the `register_entry_open_items` join and the item's
  subject stays `PROJECT` (ADR-0036) — the third record to answer this way. The spec's
  `### Core records` line still names a register entry as a `subject_type`; it is overruled.
  If a change touches the pending items view to make story 79 work, it is wrong.
- The clock is an **arithmetic over the handoff history** and never a column (ADR-0037).
  `inCourtMs` sums the intervals whose handoff says `in_our_court` — each opened by a handoff
  and closed by the next, the last running to `timeSource.now()`. There is no `clock_started`,
  though the PRD sketch names one: the ball reaches us more than once, so there is no single
  moment a clock began, and a column meaning "the first time" would answer the wrong question
  the second time. There is no `clock_stopped` either. The open interval clamps at zero,
  because a handoff may be dated forward and a negative one would subtract time the entry
  never spent with us.
- *Past its clock* is **three facts** and the first is that the ball is **ours now**
  (ADR-0037) — the outcome test is "nothing sitting in *my court* past its clock". That is
  what takes a disposed entry off the list with nothing having to stop a clock, and what keeps
  the predicate honest: an entry handed back is not sitting in our court however long it took
  us, and what it took us stays on the record as `inCourtMs`. A target must be set (no target
  is never past) and elapsed must *exceed* it (exactly the target is not past). `pastClock` is
  computed in one place, so a badge and the view cannot disagree about the same entry.
- Recording a disposition **stops the clock by handing the ball back** — the terminal event
  ADR-0036 left room for, taken so that this slice adds no mechanism (ADR-0037). One call and
  one transaction: it stamps `disposition` and `disposed_at` and writes a handoff. The
  handoff's party is **supplied** and never read off `from_party`: an entry's two parties are
  its fixed cast and ADR-0036 forbids reading them as whose move it is, so a route that
  guessed would write a handoff nobody asked for into the record a dispute is settled from.
  `disposed_at` comes from that handoff's own instant, so a review typed up a week later is
  dated when it happened, and a later handoff moves the ball again while the disposition
  stands.
- The disposition is **text with a CHECK** naming the five, byte-exact: `Approved`,
  `Approved as Noted`, `Revise and Resubmit`, `Rejected`, `For Record Only`. Never a database
  enum — ADR-0031's reason, three of the five being un-nameable as Prisma enum members — and
  refused at the boundary by the body schema's `enum` as well. Only a submittal has one,
  enforced **at the boundary only**, as the question rule is: the kind lives on `registers`
  and a CHECK cannot read another row. Recorded once; a second is refused rather than
  overwriting the outcome of a review.
- The turnaround target is `turnaround_days`, an **integer duration and never a date**
  (ADR-0037). The glossary strikes *due date* under RFI, and the day a review falls due is a
  function of this number and of when the ball reached us, which the history already holds.
  Set once and a second is refused: moving a target moves which entries *were* past their
  clock, backwards through every day the number was different, and the daily layer is only
  worth trusting if it cannot be made to have said something else.
- `GET /v1/clock` returns the **entries and not a number**, with `?projectId=` for one job —
  exposure's shape exactly, including the 404 on an unknown project and archived projects
  leaving the across-every-project list while keeping their own (ADR-0037). Sorted **longest
  in our court first**, which is what "oldest first" means for a record whose age is the time
  it has spent with us, and not furthest past its target, which would reorder a 7-day RFI
  above a 14-day submittal that has been here nine days longer; `created_at` breaks a tie. The
  filter runs in the application, not in a `where` clause, because the sum has an open last
  interval — the one view here whose predicate cannot be pushed into the database.
- A next round is `register_entries.previous_round_id`, unique, written by
  `POST /v1/register-entries/:id/next-round` (ADR-0037) — ADR-0028's `supersedes_id` arriving
  for a second record, with nothing written to the round it follows and `nextRoundId` on the
  wire so a screen can link forward. Submittals only. It is **not** narrowed to a Revise and
  Resubmit and requires no disposition at all: the screen offers it on that disposition, which
  is the whole of story 77, but a transmittal log is written up out of order (ADR-0036) and
  requiring the review first would refuse a legitimate backfill. The successor **inherits
  nothing** — its own clock from its own first handoff, its own target — deliberately
  departing from ADR-0028's carry-forward, because carrying a contractual term forward would
  assert a number nobody typed. The form offers the previous round's value as a default, which
  is where a convenience belongs.
