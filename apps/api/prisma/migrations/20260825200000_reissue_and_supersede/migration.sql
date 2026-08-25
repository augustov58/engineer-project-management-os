-- Reissue and supersede (issue #7). Correcting an issuance is a new row that
-- points back at the one it replaces; the row it points at is never touched,
-- which is why there is nothing here that edits `submissions`.

-- AlterTable
ALTER TABLE "submissions" ADD COLUMN "supersedes_id" TEXT;

-- CreateIndex
--
-- Unique, and that is the whole of "at most one successor": a second reissue
-- of the same predecessor is refused by the database, so the chain cannot
-- fork. Null is exempt from a unique index in PostgreSQL, so every submission
-- that supersedes nothing still coexists with every other.
CREATE UNIQUE INDEX "submissions_supersedes_id_key" ON "submissions"("supersedes_id");

-- AddForeignKey
--
-- RESTRICT on delete, matching every other foreign key here: no route deletes
-- a submission, and a superseded ancestor disappearing would take the record
-- of what was corrected with it.
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
