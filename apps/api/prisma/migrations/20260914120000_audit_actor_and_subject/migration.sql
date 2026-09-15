-- The audit line gains an actor and a subject (issue #111, ADR-0055 part 4).
--
-- Until now a line said *what* happened and *when*, and the one product whose
-- value is a defensible record had no answer anywhere to "who recorded this".
-- ADR-0055 puts that answer here and nowhere else: no model gains a
-- `created_by`, because that would be thirty-two copies of a fact this table
-- already holds in the same transaction as the write it describes.
--
-- All five columns are added nullable, which is the **expand** half of an
-- expand-migrate-contract taken inside one ticket so the suite stays green
-- throughout. What makes each of the sixty-seven writers supply an actor and a
-- subject is `AuditLine` in `src/audit.ts`, where the fields are required and
-- `tsc` refuses a caller that omits them, plus the sweep in
-- `test/audit.test.ts` that counts the call sites carrying a subject against
-- the call sites there are.
ALTER TABLE "audit_entries" ADD COLUMN "actor_id" TEXT;
ALTER TABLE "audit_entries" ADD COLUMN "agent_run_id" TEXT;
ALTER TABLE "audit_entries" ADD COLUMN "extraction_id" TEXT;
ALTER TABLE "audit_entries" ADD COLUMN "subject_type" TEXT;
ALTER TABLE "audit_entries" ADD COLUMN "subject_id" TEXT;

-- A line is written during at most one run, and `sessions_one_run` is the
-- shape this follows exactly.
--
-- Two run columns and not the one ADR-0055 part 4 names, because this product
-- has **two** run records — ADR-0043 made an extraction a record of its own
-- rather than an `agent_runs` row — and part 1 of this same ADR already
-- answered the identical question for `sessions` with two spellings and a
-- CHECK. A single `agent_run_id` would leave every line the extraction agent
-- writes carrying a person and no run, which is the criterion half-met.
ALTER TABLE "audit_entries" ADD CONSTRAINT "audit_entries_one_run" CHECK (num_nonnulls("agent_run_id", "extraction_id") <= 1);

-- RESTRICT on all three, spelled out. Prisma regenerates optional relations as
-- ON DELETE SET NULL unless the schema says otherwise, which is how four
-- foreign keys were silently loosened once already
-- (20260901023535_restore_restrict_on_delete). An audit line that lost its
-- actor because a row went away would be the record quietly forgetting who.
ALTER TABLE "audit_entries" ADD CONSTRAINT "audit_entries_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "audit_entries" ADD CONSTRAINT "audit_entries_agent_run_id_fkey" FOREIGN KEY ("agent_run_id") REFERENCES "agent_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "audit_entries" ADD CONSTRAINT "audit_entries_extraction_id_fkey" FOREIGN KEY ("extraction_id") REFERENCES "register_entry_extractions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Every existing line is backfilled to the author (ADR-0055 part 4).
--
-- The first account is the one made by the command on the machine, and it is
-- the only person who has ever written a line here: `users` did not exist
-- until issue #105, twenty-two slices in, and no second account has written
-- anything since. Ordered by `created_at` so "the author" means the first
-- account and not whichever uuid sorts lowest.
--
-- The `EXISTS` is for the deployment that has audit rows and no accounts at
-- all — every one that ran before #105 and never ran the command. There the
-- lines keep a null actor, which is the truth about them.
--
-- **`subject_type` and `subject_id` are deliberately not backfilled.** The
-- rows written before this migration touched records nothing here now knows,
-- and writing "project" onto a line that was about an observation would be a
-- wrong answer rather than a missing one — ADR-0039's rule against classifying
-- by omission, applied to an append-only table where a wrong answer cannot be
-- corrected. They stay null, and nothing written from here on may lack one.
UPDATE "audit_entries"
SET "actor_id" = (SELECT "id" FROM "users" ORDER BY "created_at" ASC, "id" ASC LIMIT 1)
WHERE "actor_id" IS NULL
  AND EXISTS (SELECT 1 FROM "users");
