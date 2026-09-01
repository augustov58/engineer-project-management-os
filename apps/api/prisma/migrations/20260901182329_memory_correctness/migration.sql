-- AlterTable
ALTER TABLE "project_memory_versions" ADD COLUMN     "seq" SERIAL NOT NULL;

-- `seq` is the tie-break that makes "the current memory is the latest" a fact
-- (issue #42). `id` is a random v4 uuid and `created_at` is TIMESTAMP(3), so
-- two versions written in the same millisecond ordered at random and the
-- older of the two could read as the current memory.
--
-- The backfill takes the sequence in the order Postgres reads the existing
-- rows, which is insertion order for a table nothing has ever updated or
-- deleted from — and nothing does: a version is written and never touched.

-- A proposal is pending or answered once, never both (issue #42). The routes'
-- pending check is a read and not a bound: a concurrent accept and reject each
-- passed it and each committed, leaving a row with both stamps that reported
-- itself accepted while the audit carried both answers.
--
-- Each route now settles the row by compare-and-set as well, so the ordinary
-- loser is answered 409; this CHECK is what makes the impossibility the
-- database's rather than the routes', which is what `schema.prisma` had
-- claimed all along.
ALTER TABLE "memory_proposals" ADD CONSTRAINT "memory_proposals_answered_once"
CHECK (NOT ("accepted_at" IS NOT NULL AND "rejected_at" IS NOT NULL));
