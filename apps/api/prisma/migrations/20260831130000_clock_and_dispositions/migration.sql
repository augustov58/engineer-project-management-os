-- The clock and dispositions, issue #15 (MVP slice 14).
--
-- The second half of the daily layer: nothing sitting in my court past its
-- clock. Slice 13 built the handoff history; this reads it.
--
-- Four columns on "register_entries" and no new table. Elapsed in-court time
-- is the sum of the intervals in "ball_in_court_events" where "in_our_court"
-- is true, computed on every read and stored nowhere — which is why there is
-- no "clock_started" here though the PRD sketch names one. A stored start
-- would be a second place a fact the history already holds could live, and it
-- would be free to disagree with the history in exactly the dispute the
-- history exists to settle (ADR-0036). There is no "clock_stopped" either:
-- recording a disposition stops the clock by handing the ball back in the same
-- call, and accrual reads the handoffs.
--
-- What it deliberately does NOT do: no status column on an entry and no
-- "ball_in_court" column, still — their absence is the readable test that
-- ADR-0036 stands, and the clock arriving is exactly the moment somebody would
-- be tempted to add one. No third figure beside exposure and the clock, and
-- nothing that combines them (ADR-0016).

-- AlterTable
--
-- "turnaround_days" is a **duration and never a date** (story 73). It is the
-- number the contract names; the day it falls due is a function of it and of
-- when the ball reached us, which the history already holds. The glossary
-- strikes "due date" under RFI for the same reason. Named for its unit rather
-- than the sketch's "turnaround_target", which says nothing about what it is
-- measured in. Null is the ordinary state of an entry nobody has put a number
-- on, and such an entry is never past its clock — there is nothing to be past.
--
-- "disposition" is TEXT and not an enum, which ADR-0036 decided in advance by
-- ADR-0031's reasoning: "Approved as Noted", "Revise and Resubmit" and "For
-- Record Only" cannot be Prisma enum members, so an enum would put
-- APPROVED_AS_NOTED on the wire with the real words in a lookup in the API and
-- again in the frontend. The register kind is an enum for the opposite reason
-- — SUBMITTAL and RFI name themselves.
--
-- "previous_round_id" is the round this entry follows, where a Revise and
-- Resubmit brought one back (story 77). ADR-0028's "supersedes_id" exactly.
ALTER TABLE "register_entries"
    ADD COLUMN "turnaround_days" INTEGER,
    ADD COLUMN "disposition" TEXT,
    ADD COLUMN "disposed_at" TIMESTAMP(3),
    ADD COLUMN "previous_round_id" TEXT;

-- CreateIndex
--
-- Unique, which is the whole of "at most one next round, and the chain is
-- linear" — held by the database rather than by a guard that can be forgotten,
-- as it is for a superseding submission. Cycles cannot arise: the successor is
-- created already pointing backwards and nothing ever repoints it.
CREATE UNIQUE INDEX "register_entries_previous_round_id_key" ON "register_entries"("previous_round_id");

-- AddForeignKey
--
-- RESTRICT on delete, matching "submissions_supersedes_id_fkey", which is the
-- same shape: an optional unique self-reference.
ALTER TABLE "register_entries" ADD CONSTRAINT "register_entries_previous_round_id_fkey" FOREIGN KEY ("previous_round_id") REFERENCES "register_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddConstraint
--
-- A turnaround of zero days is not a target and a negative one is not a
-- number. Refused by the body schema at the boundary and again here, the
-- double enforcement ADR-0030 gave the one-axis rule and ADR-0031 gave the
-- category.
ALTER TABLE "register_entries" ADD CONSTRAINT "register_entries_turnaround_is_positive" CHECK ("turnaround_days" IS NULL OR "turnaround_days" > 0);

-- AddConstraint
--
-- The closed set of five, byte-exact and in the order every source writes
-- them. "Enforce them in the schema, not only in the interface" is what the
-- spec asks of a closed set, and story 75 asks that nobody invent a sixth.
--
-- Which *kind* may carry one is not here and cannot be: the kind lives on
-- "registers" and a CHECK cannot read another row, so only a submittal having
-- a disposition is the boundary's, exactly as only an RFI having a question
-- is (ADR-0036).
ALTER TABLE "register_entries" ADD CONSTRAINT "register_entries_disposition_is_one_of_five" CHECK ("disposition" IS NULL OR "disposition" IN ('Approved', 'Approved as Noted', 'Revise and Resubmit', 'Rejected', 'For Record Only'));

-- AddConstraint
--
-- Both null or both set: an outcome with no date is not a record of a review,
-- and a date with no outcome says nothing. ADR-0024's shape for resolution and
-- ADR-0031's for a close, arriving for a third pair.
ALTER TABLE "register_entries" ADD CONSTRAINT "register_entries_disposition_is_dated" CHECK (("disposition" IS NULL) = ("disposed_at" IS NULL));
