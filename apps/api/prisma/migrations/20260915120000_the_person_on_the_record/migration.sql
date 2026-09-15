-- The record says whose it is, where the record is about a person
-- (issue #112, ADR-0055 part 5).
--
-- Issue #111 put an actor on the audit line and stopped there, deliberately:
-- "who recorded this" is a read of the audit and no model gains a
-- `created_by`. These three columns are a different question and the one
-- ADR-0055 part 5 asks. Who **walked** a building is the name its report
-- prints; who an open item **sits with** is what *mine* means on the pending
-- items view; who a ball **came to** is whose court it is in. All three are
-- editable, none of them says who typed the row, and the audit still answers
-- that on its own.
--
-- Each is backfilled to the first account, which is the reasoning
-- `20260914120000_audit_actor_and_subject` used for `actor_id` and which holds
-- here for the same reason: `users` did not exist until issue #105,
-- twenty-two slices in, so every row older than that was made by the one
-- person there has ever been. Ordered by `created_at` so "the author" means
-- the first account and not whichever uuid sorts lowest.
--
-- A deployment with rows here and no accounts at all stops on the NOT NULL
-- below rather than inventing an owner for them. That is the same refusal
-- `20260912000000_project_timezone_and_real_instants` takes for a project
-- left without a zone: there is no answer, and a made-up one is worse than a
-- migration that will not run.

-- Who walked the building. `conducted_by` and not `conducted_by_id`, because
-- the glossary headword is **Conducted by** and the column is read in SQL by
-- people; the Prisma field is `conductedById`, which is that client's own
-- convention for a relation's scalar.
ALTER TABLE "site_visits" ADD COLUMN "conducted_by" TEXT;

UPDATE "site_visits"
SET "conducted_by" = (SELECT "id" FROM "users" ORDER BY "created_at" ASC, "id" ASC LIMIT 1)
WHERE "conducted_by" IS NULL;

ALTER TABLE "site_visits" ALTER COLUMN "conducted_by" SET NOT NULL;

ALTER TABLE "site_visits" ADD CONSTRAINT "site_visits_conducted_by_fkey" FOREIGN KEY ("conducted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The open item's owner stops being free text.
--
-- **The old column's text is dropped and cannot be carried over**: it held
-- initials and short names — "AV" — with nothing to resolve them against, and
-- the one account they can only have meant is the one every row is backfilled
-- to anyway. Said here rather than discovered, because a `DROP COLUMN` is the
-- one statement in this file that destroys something.
--
-- NOT NULL where the text was nullable: an item is now raised *by* somebody,
-- so it always sits with somebody, and "unowned" was never an answer worth
-- keeping — **waiting on** is where *nobody* is a real value, and it still is.
ALTER TABLE "open_items" ADD COLUMN "owner_id" TEXT;

UPDATE "open_items"
SET "owner_id" = (SELECT "id" FROM "users" ORDER BY "created_at" ASC, "id" ASC LIMIT 1)
WHERE "owner_id" IS NULL;

ALTER TABLE "open_items" ALTER COLUMN "owner_id" SET NOT NULL;

ALTER TABLE "open_items" ADD CONSTRAINT "open_items_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "open_items" DROP COLUMN "owner";

-- A handoff that brings the ball to us names the person it comes to.
--
-- Nullable, because most handoffs are to a contractor or an architect and a
-- party is not a user (ADR-0036: `party`, `from_party` and `to_party` stay
-- free text). The CHECK is what makes the column mean something: set exactly
-- when the ball is ours, refused in both directions, which is ADR-0030's
-- one-axis rule arriving for a second record — an axis with no optional
-- segment, enforced by the body schema *and* underneath it, because it is a
-- property of the record rather than a habit of the interface.
ALTER TABLE "ball_in_court_events" ADD COLUMN "user_id" TEXT;

UPDATE "ball_in_court_events"
SET "user_id" = (SELECT "id" FROM "users" ORDER BY "created_at" ASC, "id" ASC LIMIT 1)
WHERE "in_our_court" AND "user_id" IS NULL;

ALTER TABLE "ball_in_court_events" ADD CONSTRAINT "ball_in_court_events_ours_is_somebodys" CHECK (("in_our_court" AND "user_id" IS NOT NULL) OR (NOT "in_our_court" AND "user_id" IS NULL));

ALTER TABLE "ball_in_court_events" ADD CONSTRAINT "ball_in_court_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
