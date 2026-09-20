-- The project chat: a conversation on a project that reads, asks the helpers,
-- and proposes an assumption record (issue #121, ADR-0058 part 4).
--
-- "20260916000000_a_conversation_is_a_record" built parts 1, 2, 3 and 5 in the
-- visit context and said this one would land without a second migration to
-- "conversations": "site_visit_id" is already nullable and unique, and a
-- project-level row needs nothing new there. That holds — nothing below touches
-- that table.
--
-- What is new is three things, and all three are ADR-0058's own consequences.
-- The agent's turn may now propose an **assumption record** rather than a draft
-- observation: a submission, the two blocks verbatim, and the code edition.
-- "assumption_records" gains the nullable turn reference that ADR-0058 names as
-- the provenance of a record reached through the chat rather than through the
-- paste. And the engineer's turn stops having to be a **capture**: on a project
-- there is no walk to record a kind or an instant against, which is what the
-- "kind" column's own comment has said since it was written.

-- AlterTable
--
-- What the agent proposed on its own turn when what it proposed is an
-- assumption record (ADR-0058 part 4).
--
-- Columns on the row and not a proposals table, which is what the draft
-- observation's five already are and for ADR-0043's reasons: there is no base
-- to snapshot, and the engineer edits the fields at confirmation rather than
-- against a drifting original.
--
-- The two blocks are held here exactly as the helper printed them. Nothing
-- trims, normalises or re-wraps them on the way in or on the way out, which is
-- ADR-0029's rule reaching one row earlier than it used to: what the confirm
-- writes into "assumption_records" is what is sitting here.
ALTER TABLE "turns" ADD COLUMN "proposed_submission_id" TEXT;
ALTER TABLE "turns" ADD COLUMN "proposed_assumptions" TEXT;
ALTER TABLE "turns" ADD COLUMN "proposed_flags" TEXT;
ALTER TABLE "turns" ADD COLUMN "proposed_code_edition" TEXT;

-- AddForeignKey
ALTER TABLE "turns" ADD CONSTRAINT "turns_proposed_submission_id_fkey"
    FOREIGN KEY ("proposed_submission_id") REFERENCES "submissions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
--
-- The turn a record was confirmed from, or null on one that was pasted in
-- (ADR-0058: "assumption_records gains a nullable turn reference. The paste
-- path stands; the chat path is the same record reached without the paste").
--
-- UNIQUE, which is the whole of "one proposal, at most one record": confirming
-- the same turn twice is refused by the database rather than by a guard that
-- can be forgotten. It is the shape "turns"."observation_id" has on the other
-- record, pointing the other way because the record is what gains the column.
ALTER TABLE "assumption_records" ADD COLUMN "turn_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "assumption_records_turn_id_key" ON "assumption_records"("turn_id");

-- AddForeignKey
ALTER TABLE "assumption_records" ADD CONSTRAINT "assumption_records_turn_id_fkey"
    FOREIGN KEY ("turn_id") REFERENCES "turns"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- DropConstraint
--
-- The engineer's turn is a **capture** on a walk and is not one on a project.
--
-- The constraint written in September said an engineer's turn always carries
-- the capture machinery — a kind, a key and an instant. That was true of every
-- turn that could then exist, and the "kind" column's own comment already said
-- what would change here: "It would also be null on an engineer's turn in a
-- project conversation, which is the project chat's ticket and not this one."
--
-- What replaces it says the same thing one degree looser: the machinery is
-- carried **whole or not at all**. A kind without an instant, or an instant
-- without a kind, is still refused, so a half-recorded capture is as impossible
-- as it was. A turn with neither is a project turn, and it has to have its
-- words, because there is no vendor coming later with them — which is the
-- guarantee "turns_typed_has_its_words" gives the kind it names and could not
-- give a turn with no kind at all.
--
-- The **key stays required**, on a project turn as much as on a walk's. A
-- capture key is not about audio: it is how a send that did not visibly land is
-- retried without saying the same thing twice, and a desk on a bad connection
-- is not different from a phone in a basement.
ALTER TABLE "turns" DROP CONSTRAINT "turns_engineer_captures";

ALTER TABLE "turns" ADD CONSTRAINT "turns_engineer_captures" CHECK (
    ("speaker" = 'ENGINEER' AND "capture_key" IS NOT NULL
        AND (("kind" IS NULL) = ("recorded_at" IS NULL))
        AND ("kind" IS NOT NULL OR "transcript" IS NOT NULL))
    OR ("speaker" = 'AGENT' AND "kind" IS NULL AND "capture_key" IS NULL AND "recorded_at" IS NULL)
);

-- DropConstraint
--
-- Only the agent's turn proposes, and the four new columns join the six that
-- already could not appear on an engineer's.
ALTER TABLE "turns" DROP CONSTRAINT "turns_agent_proposes";

ALTER TABLE "turns" ADD CONSTRAINT "turns_agent_proposes" CHECK (
    "speaker" = 'AGENT' OR (
        "agent_run_id" IS NULL
        AND "proposed_observed" IS NULL AND "proposed_floor" IS NULL
        AND "proposed_qualifier" IS NULL AND "proposed_side" IS NULL
        AND "proposed_sector" IS NULL AND "proposed_issue_id" IS NULL
        AND "proposed_submission_id" IS NULL AND "proposed_assumptions" IS NULL
        AND "proposed_flags" IS NULL AND "proposed_code_edition" IS NULL
    )
);

-- AddConstraint
--
-- A proposed assumption record is whole or absent, which is
-- "turns_proposed_one_axis"' shape applied to the other proposal.
--
-- The record's own route requires all three of the blocks and the code edition
-- and binds them to one submission; a proposal carrying three of the four would
-- be a confirm that cannot be made, discovered at the confirm rather than at the
-- propose.
ALTER TABLE "turns" ADD CONSTRAINT "turns_proposed_record_is_whole" CHECK (
    ("proposed_submission_id" IS NULL AND "proposed_assumptions" IS NULL
        AND "proposed_flags" IS NULL AND "proposed_code_edition" IS NULL)
    OR ("proposed_submission_id" IS NOT NULL AND "proposed_assumptions" IS NOT NULL
        AND "proposed_flags" IS NOT NULL AND "proposed_code_edition" IS NOT NULL)
);

-- AddConstraint
--
-- One turn proposes one thing. An observation is a walk's conversation and an
-- assumption record is a project's, so a row carrying both would be a turn on
-- neither — and the confirm screen would have two forms and no way to say which
-- was the answer.
ALTER TABLE "turns" ADD CONSTRAINT "turns_proposes_one_record" CHECK (
    "proposed_observed" IS NULL OR "proposed_submission_id" IS NULL
);
