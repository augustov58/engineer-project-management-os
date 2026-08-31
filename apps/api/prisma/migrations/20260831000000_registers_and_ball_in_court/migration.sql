-- Registers, entries and the ball-in-court history, issue #14 (MVP slice 13).
--
-- Four tables and one type. A register is the log of one correspondence type
-- on one job — submittals, RFIs. Beneath it, entries: the number the piece of
-- correspondence is filed under, its subject, the parties, an RFI's question
-- and later its answer, and the issuance that responded to it. Beneath each
-- entry, the handoffs: from this moment, the ball is in the named party's
-- court.
--
-- Two register kinds as rows in one table, not two parallel tables, which the
-- spec's data model states outright and story 70 asks for.
--
-- **The handoff history is the point of this slice.** The PRD settled it on
-- 2026-08-24 and gave the reason: the clock accrues only while the ball is in
-- our court, so elapsed in-court time is computable *only* from the sequence
-- of handoffs. A single "ball_in_court" column makes turnaround unauditable in
-- exactly the dispute it exists to settle. Issue #15 does that arithmetic;
-- this migration gives it something to read.
--
-- What it deliberately does NOT do: no status column on an entry, and no
-- "ball_in_court" column beside the events — whose move it is now is the last
-- handoff, derived on every read and stored nowhere, the shape ADR-0027 gave
-- *currently provisional* and ADR-0028 gave *superseded*. No "clock_started",
-- no "turnaround_target" and no "disposition", though the PRD sketch names all
-- three as entry fields: they are issue #15's, and a nullable column nothing
-- writes is a column nobody can trust. No second value in "open_item_subject"
-- — an open item on an entry is a join and its subject stays PROJECT, for the
-- third time and for ADR-0031's reasons. No foreign key from "submissions" to
-- an entry: that column could only be written after the set went out, and no
-- route updates a submission (ADR-0026).

-- CreateEnum
--
-- The second database enum here, where every closed set since ADR-0024 has
-- been text with a CHECK. That rule has a reason and the reason is absent:
-- an issue's category could not be an enum because a Prisma enum member cannot
-- be named "Physical / Safety", so the wire would have carried PHYSICAL_SAFETY
-- with the real words in a lookup beside it. SUBMITTAL and RFI name
-- themselves, so "open_item_subject" is the live precedent — a set closed by
-- what the product is, where a third correspondence type is a migration rather
-- than a string a caller invents.
CREATE TYPE "register_kind" AS ENUM ('SUBMITTAL', 'RFI');

-- CreateTable
--
-- A scope and nothing else: the thing an entry's number is unique within. It
-- carries no state, and there is no create route and no delete — which
-- correspondence types exist is a fact about the product, not a choice about a
-- job. A phase is the opposite case and is created by hand for that reason
-- (ADR-0026).
CREATE TABLE "registers" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "kind" "register_kind" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- The entry owns what it is *about* and owns nothing about whose move it is.
--
-- "number" is the engineer's and never allocated: these come off the
-- contractor's transmittal and the job's own conventions, so a sequence of
-- ours would be a second identifier for a thing that already has one. That is
-- the opposite of an issue's number (ADR-0031), which exists precisely because
-- a finding arrives with none.
--
-- "question" and "response" are null on a submittal. Which kind may carry them
-- is enforced at the boundary rather than by a CHECK, unlike the one-axis rule
-- and the category: the kind lives on "registers", and a CHECK cannot read
-- another row. Copying it down here to make one possible would be the second
-- place the same fact lives that this schema refuses everywhere else.
CREATE TABLE "register_entries" (
    "id" TEXT NOT NULL,
    "register_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "from_party" TEXT NOT NULL,
    "to_party" TEXT NOT NULL,
    "question" TEXT,
    "response" TEXT,
    "submission_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "register_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- "in_our_court" is a second fact and not one derived from "party". Issue #15
-- sums the intervals where it is true, and reading that off the name would
-- make the product's central number a string comparison against a value the
-- engineer typed — where ADR-0024 could reserve the word "nobody" for
-- "waiting_on" because no arithmetic counts on it. A job that calls us by the
-- firm's name still accrues.
--
-- "held_since" and not "at", matching an open item's "waiting_since": the row
-- is the start of an interval that the next row ends, which is the shape #15's
-- accrual reads. No database default, and settable by the engineer, because
-- handoffs are entered from a transmittal log after the fact — ADR-0022 names
-- this slice when it says the register inherits that rule.
CREATE TABLE "ball_in_court_events" (
    "id" TEXT NOT NULL,
    "register_entry_id" TEXT NOT NULL,
    "party" TEXT NOT NULL,
    "in_our_court" BOOLEAN NOT NULL,
    "held_since" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ball_in_court_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- The "issue_open_items" shape exactly. A join and not a subject, for the
-- third time: the item's "subject_type" stays PROJECT and its "subject_id"
-- stays the job, so "cannot review this until the load data arrives" reaches
-- the pending items view carrying the job it is on. Nothing in that view
-- changes for this slice, which is the sign the shape is right.
CREATE TABLE "register_entry_open_items" (
    "register_entry_id" TEXT NOT NULL,
    "open_item_id" TEXT NOT NULL,

    CONSTRAINT "register_entry_open_items_pkey" PRIMARY KEY ("register_entry_id","open_item_id")
);

-- CreateIndex
--
-- One register of each kind per job, which is the whole of "a submittals
-- register and an RFIs register per project" — held by the database rather
-- than by the route that writes them.
CREATE UNIQUE INDEX "registers_project_id_kind_key" ON "registers"("project_id", "kind");

-- CreateIndex
--
-- A number is unique within its register and not within the job, so the same
-- number may be both a submittal and an RFI — which is how the two logs
-- number independently — and never twice in one log.
CREATE UNIQUE INDEX "register_entries_register_id_number_key" ON "register_entries"("register_id", "number");

-- CreateIndex
CREATE INDEX "register_entries_register_id_created_at_idx" ON "register_entries"("register_id", "created_at");

-- CreateIndex
--
-- The handoff sequence for one entry, in the order the ball actually moved.
CREATE INDEX "ball_in_court_events_register_entry_id_held_since_idx" ON "ball_in_court_events"("register_entry_id", "held_since");

-- CreateIndex
CREATE INDEX "register_entry_open_items_open_item_id_idx" ON "register_entry_open_items"("open_item_id");

-- AddForeignKey
--
-- RESTRICT on delete throughout, matching every other foreign key here.
ALTER TABLE "registers" ADD CONSTRAINT "registers_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "register_entries" ADD CONSTRAINT "register_entries_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "register_entries" ADD CONSTRAINT "register_entries_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ball_in_court_events" ADD CONSTRAINT "ball_in_court_events_register_entry_id_fkey" FOREIGN KEY ("register_entry_id") REFERENCES "register_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "register_entry_open_items" ADD CONSTRAINT "register_entry_open_items_register_entry_id_fkey" FOREIGN KEY ("register_entry_id") REFERENCES "register_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "register_entry_open_items" ADD CONSTRAINT "register_entry_open_items_open_item_id_fkey" FOREIGN KEY ("open_item_id") REFERENCES "open_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddConstraint
--
-- A response without a question is not an answer to anything. The one
-- invariant on this row a CHECK can reach: the other half of the rule — that
-- only an RFI carries either — needs the register's kind and so is the
-- boundary's, as the comment on the table above says.
ALTER TABLE "register_entries" ADD CONSTRAINT "register_entries_response_needs_question" CHECK ("response" IS NULL OR "question" IS NOT NULL);

-- Backfill
--
-- Both registers for every project that already exists, so "always exactly
-- two" is true of the jobs entered before this migration and not only of the
-- ones created after it. Dated from the project rather than from now(): the
-- log has existed as long as the job has, and now() is the wall clock ADR-0022
-- keeps out of domain-meaningful columns.
INSERT INTO "registers" ("id", "project_id", "kind", "created_at")
SELECT gen_random_uuid(), "projects"."id", "kind", "projects"."created_at"
FROM "projects"
CROSS JOIN (VALUES ('SUBMITTAL'::"register_kind"), ('RFI'::"register_kind")) AS "kinds"("kind");
