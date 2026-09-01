-- DropForeignKey
ALTER TABLE "photos" DROP CONSTRAINT "photos_issue_id_fkey";

-- DropForeignKey
ALTER TABLE "register_entries" DROP CONSTRAINT "register_entries_previous_round_id_fkey";

-- DropForeignKey
ALTER TABLE "register_entries" DROP CONSTRAINT "register_entries_submission_id_fkey";

-- DropForeignKey
ALTER TABLE "submissions" DROP CONSTRAINT "submissions_supersedes_id_fkey";

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photos" ADD CONSTRAINT "photos_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "register_entries" ADD CONSTRAINT "register_entries_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "register_entries" ADD CONSTRAINT "register_entries_previous_round_id_fkey" FOREIGN KEY ("previous_round_id") REFERENCES "register_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
