-- A photograph evidences what was seen, and a floor-only photograph is unfiled
-- (issue #113, ADR-0056).
--
-- `20260828000000_photos_and_binning` recorded the opposite in its own header:
-- "no `photo_observations` join — photo evidence lands on the floor and on the
-- finding, not on the observation, and ADR-0032 records why". That reasoning
-- was one load-bearing sentence — "there is no third mechanism that would bind
-- a photograph to one observation out of the dozen made on a floor" — and the
-- very next slice built one, `voice_captures.observation_id`, and framed it as
-- a draft mechanism so nobody read it as the binding 0032 said did not exist.
-- The earlier file is history and is left saying what was true when it ran.
--
-- No join table, and that is the same answer as before rather than a reversal:
-- a photograph evidences **one** thing. `observation_id` beside `issue_id`
-- under a CHECK is the shape, not a second `issue_observations`.

-- AlterTable
--
-- Nullable, as `issue_id` is, and with the same `ON DELETE RESTRICT`: nothing
-- deletes an observation, so this is a guarantee rather than a policy.
ALTER TABLE "photos" ADD COLUMN "observation_id" TEXT;

-- AddForeignKey
ALTER TABLE "photos" ADD CONSTRAINT "photos_observation_id_fkey" FOREIGN KEY ("observation_id") REFERENCES "observations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddConstraint
--
-- At most one of the two, which is `num_nonnulls(...) <= 1` and pointedly not
-- the `<>` the one-axis rule on `observations` uses: neither binding set is a
-- real state — a **floor-only photograph**, the unfiled case ADR-0056 names and
-- makes the report count. Only both at once is refused, because a photograph on
-- a sighting of Issue N that was also stamped to Issue M would print under two
-- findings, and the report would say the same picture evidenced both.
--
-- `sessions_one_run` and `audit_entries_one_run` are the same form for the same
-- reason. Nothing needs backfilling: the column is new and every existing row
-- has it null, so no row can already violate this.
ALTER TABLE "photos" ADD CONSTRAINT "photos_evidences_one_thing" CHECK (num_nonnulls("observation_id", "issue_id") <= 1);

-- CreateIndex
--
-- An observation's screen reads its photographs and the report reads a
-- finding's through its sightings, so this column is looked up by value on
-- every walk that has one — the reason `issue_id` has an index beside it.
CREATE INDEX "photos_observation_id_idx" ON "photos"("observation_id");
