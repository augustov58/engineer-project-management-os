-- A conversation is a record, and the chat proposes a draft the engineer
-- commits (issue #114, ADR-0057 as amended by ADR-0058).
--
-- ADR-0057 wrote "a conversation is the sequence of a visit's captures; it is
-- not an agent run and has no table of its own". ADR-0058 withdrew that one
-- sentence before either was built — two conversations with two records would
-- be the shape this product refuses — and "voice_captures" becomes "turns"
-- rather than "captures". That rename happens here, once.
--
-- "20260829000000_voice_capture_and_draft_observation" is history and is left
-- saying what was true when it ran. Everything it decided still holds: the
-- draft is the row and not a state of an observation, the audio is not here,
-- the four stamps are the whole of the transcription state, and a resend under
-- the same capture key is answered rather than refused.
--
-- What is new is three things. A "conversations" table, one row per site visit
-- created with it and any number per project. A "turns" table that is the old
-- one widened: a typed capture beside a spoken one, and the agent's reply as a
-- turn of its own carrying the draft it proposes. And a link from "agent_runs"
-- to the conversation a run is a turn on — NOT the "kind" column ADR-0040
-- refused, but the link "sessions"."agent_run_id" already is, which is what
-- lets the memory screen narrow its list without that column existing.

-- CreateEnum
--
-- Whose turn it is. Database enums for ADR-0036's reason, which is the reason
-- ADR-0057 named this one for: the set is the record's and nothing outside
-- this product can write it.
CREATE TYPE "turn_speaker" AS ENUM ('ENGINEER', 'AGENT');

-- CreateEnum
CREATE TYPE "turn_kind" AS ENUM ('VOICE', 'TYPED');

-- CreateTable
--
-- "site_visit_id" is nullable and UNIQUE: nullable because a project-level
-- conversation has no walk (the project chat's ticket, not this one), UNIQUE
-- because "exactly one per visit" is a fact the database holds rather than a
-- guard a route remembers.
--
-- "project_id" is set on both kinds, including a visit's, where it is the
-- visit's own project read once at creation. Not derived through the join:
-- every route that answers for a conversation needs it, and a walk cannot
-- change job.
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "site_visit_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversations_site_visit_id_key" ON "conversations"("site_visit_id");

-- CreateIndex
CREATE INDEX "conversations_project_id_created_at_idx" ON "conversations"("project_id", "created_at");

-- AddForeignKey
--
-- RESTRICT on delete throughout, matching every other foreign key here.
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_site_visit_id_fkey" FOREIGN KEY ("site_visit_id") REFERENCES "site_visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill
--
-- Every walk that exists gets its conversation, because "created with the
-- visit" has to be true of the walks recorded before this ran as well as of
-- the ones recorded after. Dated from the visit's own "created_at": the
-- conversation is as old as the walk, and stamping it "now" would put a row in
-- the record dated a migration.
INSERT INTO "conversations" ("id", "project_id", "site_visit_id", "created_at")
SELECT gen_random_uuid()::TEXT, "project_id", "id", "created_at" FROM "site_visits";

-- RenameTable
--
-- The record is the same one, widened. Renaming rather than creating and
-- copying keeps every row's id, so a "photos"."observation_id" or an audit
-- line that already points at what one of these became still points at it.
ALTER TABLE "voice_captures" RENAME TO "turns";

-- Postgres carries the old names on every constraint and index a rename does
-- not touch, and a schema whose constraint names disagree with its table's is
-- one nobody can read an error message from.
ALTER TABLE "turns" RENAME CONSTRAINT "voice_captures_pkey" TO "turns_pkey";
ALTER TABLE "turns" RENAME CONSTRAINT "voice_captures_site_visit_id_fkey" TO "turns_site_visit_id_fkey";
ALTER TABLE "turns" RENAME CONSTRAINT "voice_captures_observation_id_fkey" TO "turns_observation_id_fkey";
ALTER TABLE "turns" RENAME CONSTRAINT "voice_captures_content_type" TO "turns_content_type";
ALTER TABLE "turns" RENAME CONSTRAINT "voice_captures_byte_size" TO "turns_byte_size";
ALTER INDEX "voice_captures_storage_key_key" RENAME TO "turns_storage_key_key";
ALTER INDEX "voice_captures_observation_id_key" RENAME TO "turns_observation_id_key";
ALTER INDEX "voice_captures_site_visit_id_recorded_at_idx" RENAME TO "turns_site_visit_id_recorded_at_idx";
ALTER INDEX "voice_captures_site_visit_id_capture_key_key" RENAME TO "turns_site_visit_id_capture_key_key";

-- AlterTable
--
-- The turn's own columns. "conversation_id" is NOT NULL once backfilled below;
-- "speaker" and "position" likewise. Everything else is null by role, which is
-- ADR-0043's precedent for one table holding one concept whose columns differ
-- by which kind of row it is — refused as two tables, because a capture and a
-- reply are two turns of one conversation and not two records.
ALTER TABLE "turns" ADD COLUMN "conversation_id" TEXT;
ALTER TABLE "turns" ADD COLUMN "speaker" "turn_speaker";
ALTER TABLE "turns" ADD COLUMN "position" INTEGER;
ALTER TABLE "turns" ADD COLUMN "kind" "turn_kind";
ALTER TABLE "turns" ADD COLUMN "agent_run_id" TEXT;
ALTER TABLE "turns" ADD COLUMN "proposed_observed" TEXT;
ALTER TABLE "turns" ADD COLUMN "proposed_floor" TEXT;
ALTER TABLE "turns" ADD COLUMN "proposed_qualifier" TEXT;
ALTER TABLE "turns" ADD COLUMN "proposed_side" TEXT;
ALTER TABLE "turns" ADD COLUMN "proposed_sector" TEXT;
ALTER TABLE "turns" ADD COLUMN "proposed_issue_id" TEXT;

-- Backfill
--
-- Every recording already on a walk is that walk's conversation's turn: the
-- engineer's, spoken, in the order it was made. "position" counts from 1 in
-- the order the review list already read in — "recorded_at" then "created_at",
-- which is "voice_captures_made"'s ordering and the order the walk happened
-- in.
UPDATE "turns" SET "conversation_id" = "conversations"."id"
FROM "conversations" WHERE "conversations"."site_visit_id" = "turns"."site_visit_id";

UPDATE "turns" SET "speaker" = 'ENGINEER', "kind" = 'VOICE';

UPDATE "turns" SET "position" = "ordered"."position"
FROM (
    SELECT "id", ROW_NUMBER() OVER (
        PARTITION BY "conversation_id" ORDER BY "recorded_at", "created_at", "id"
    ) AS "position"
    FROM "turns"
) AS "ordered"
WHERE "ordered"."id" = "turns"."id";

-- AlterTable
--
-- What every turn has, now that every existing row has it.
ALTER TABLE "turns" ALTER COLUMN "conversation_id" SET NOT NULL;
ALTER TABLE "turns" ALTER COLUMN "speaker" SET NOT NULL;
ALTER TABLE "turns" ALTER COLUMN "position" SET NOT NULL;

-- AlterTable
--
-- What a turn has only in some role. All four were NOT NULL when every row was
-- a recording: a typed capture has no audio and the agent's turn is neither
-- made on a site nor sent by a phone, so each is now held by the CHECKs below
-- rather than by the column.
ALTER TABLE "turns" ALTER COLUMN "capture_key" DROP NOT NULL;
ALTER TABLE "turns" ALTER COLUMN "recorded_at" DROP NOT NULL;
ALTER TABLE "turns" ALTER COLUMN "content_type" DROP NOT NULL;
ALTER TABLE "turns" ALTER COLUMN "byte_size" DROP NOT NULL;
ALTER TABLE "turns" ALTER COLUMN "storage_key" DROP NOT NULL;

-- DropColumn
--
-- The conversation carries the walk. Keeping "site_visit_id" here as well
-- would be two places the same fact lives, free to disagree — and the resend
-- rule rekeys to the conversation, which is the same scope by another name.
ALTER TABLE "turns" DROP CONSTRAINT "turns_site_visit_id_fkey";
DROP INDEX "turns_site_visit_id_recorded_at_idx";
DROP INDEX "turns_site_visit_id_capture_key_key";
ALTER TABLE "turns" DROP COLUMN "site_visit_id";

-- CreateIndex
--
-- The reconciliation mechanism, rekeyed. The route still answers a repeat with
-- the row it already has rather than a refusal, and ADR-0057 extends that to a
-- typed turn: a tap that did not visibly land is retapped, and a conversation
-- is not a place to say the same thing twice by accident.
CREATE UNIQUE INDEX "turns_conversation_id_capture_key_key" ON "turns"("conversation_id", "capture_key");

-- CreateIndex
--
-- A conversation is read in order, always, and nothing else reads this table.
CREATE UNIQUE INDEX "turns_conversation_id_position_key" ON "turns"("conversation_id", "position");

-- CreateIndex
--
-- One run, at most one turn — "memory_proposals"."run_id"'s shape and for its
-- reason. A run that failed has no turn at all, which is the honest state:
-- there is no reply.
CREATE UNIQUE INDEX "turns_agent_run_id_key" ON "turns"("agent_run_id");

-- AddForeignKey
ALTER TABLE "turns" ADD CONSTRAINT "turns_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "turns" ADD CONSTRAINT "turns_agent_run_id_fkey" FOREIGN KEY ("agent_run_id") REFERENCES "agent_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "turns" ADD CONSTRAINT "turns_proposed_issue_id_fkey" FOREIGN KEY ("proposed_issue_id") REFERENCES "issues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddConstraint
--
-- The engineer's turn on a walk is a capture and carries the capture
-- machinery; the agent's turn is a run and carries none of it. Written here
-- and not left to the routes, unlike the stamp pairs the 2026-08-29 migration
-- deliberately did not constrain, because this is not a pair moving together —
-- it is which columns a row of this kind may have at all, which is the same
-- property "observations" holds its one-axis rule for.
ALTER TABLE "turns" ADD CONSTRAINT "turns_engineer_captures" CHECK (
    ("speaker" = 'ENGINEER' AND "kind" IS NOT NULL AND "capture_key" IS NOT NULL AND "recorded_at" IS NOT NULL)
    OR ("speaker" = 'AGENT' AND "kind" IS NULL AND "capture_key" IS NULL AND "recorded_at" IS NULL)
);

-- AddConstraint
--
-- Only the agent's turn is a run, and only the agent's turn proposes. The
-- engineer's may become an observation and the agent's may never: "the agent
-- never writes an observation" is the ticket's own sentence, and this is where
-- it is true by construction rather than by the propose route remembering.
ALTER TABLE "turns" ADD CONSTRAINT "turns_agent_proposes" CHECK (
    "speaker" = 'AGENT' OR (
        "agent_run_id" IS NULL
        AND "proposed_observed" IS NULL AND "proposed_floor" IS NULL
        AND "proposed_qualifier" IS NULL AND "proposed_side" IS NULL
        AND "proposed_sector" IS NULL AND "proposed_issue_id" IS NULL
    )
);

ALTER TABLE "turns" ADD CONSTRAINT "turns_agent_commits_nothing" CHECK (
    "speaker" = 'ENGINEER' OR ("agent_run_id" IS NOT NULL AND "observation_id" IS NULL)
);

-- AddConstraint
--
-- A recording, or no recording, and never half of one: the read route hands
-- the stored type straight back to a browser under "nosniff", so a row with a
-- key and no type would be audio served as nothing. A typed turn has none of
-- the three and has its words from the first instant.
ALTER TABLE "turns" ADD CONSTRAINT "turns_voice_has_a_recording" CHECK (
    ("kind" IS NOT DISTINCT FROM 'VOICE'::"turn_kind"
        AND "storage_key" IS NOT NULL AND "content_type" IS NOT NULL AND "byte_size" IS NOT NULL)
    OR ("kind" IS DISTINCT FROM 'VOICE'::"turn_kind"
        AND "storage_key" IS NULL AND "content_type" IS NULL AND "byte_size" IS NULL)
);

ALTER TABLE "turns" ADD CONSTRAINT "turns_typed_has_its_words" CHECK (
    "kind" IS DISTINCT FROM 'TYPED'::"turn_kind" OR "transcript" IS NOT NULL
);

-- AddConstraint
--
-- The location grammar's one-axis rule, reaching the proposal (ADR-0030).
-- Exactly one of side and sector on a proposal that carries fields at all, and
-- neither on one that carries a question — which is the same CHECK
-- "observations" has, loosened only by the row that proposes nothing.
ALTER TABLE "turns" ADD CONSTRAINT "turns_proposed_one_axis" CHECK (
    ("proposed_observed" IS NULL AND "proposed_floor" IS NULL AND "proposed_qualifier" IS NULL
        AND "proposed_side" IS NULL AND "proposed_sector" IS NULL)
    OR ("proposed_observed" IS NOT NULL AND "proposed_floor" IS NOT NULL
        AND "proposed_qualifier" IS NOT NULL
        AND (("proposed_side" IS NULL) <> ("proposed_sector" IS NULL)))
);

-- AlterTable
--
-- The conversation a run is a turn on, or null for a memory run.
--
-- ADR-0043 refused to reuse this table for an extraction because it "has no
-- `kind` column — 0040's deliberate shape — so a memory screen reading it per
-- project could not keep an extraction run out of its list". ADR-0058 requires
-- every agent turn to be a row here, so that objection has to be answered, and
-- it is answered with a **link** and not a kind: the memory read narrows on
-- this column being null, which is what "sessions"."agent_run_id" and
-- "sessions"."extraction_id" already do for the same question one level down.
ALTER TABLE "agent_runs" ADD COLUMN "conversation_id" TEXT;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
--
-- The conversation's runs, which is how the worker and the screen both read
-- them; the memory read is covered by "agent_runs_project_id_created_at_idx".
CREATE INDEX "agent_runs_conversation_id_created_at_idx" ON "agent_runs"("conversation_id", "created_at");
