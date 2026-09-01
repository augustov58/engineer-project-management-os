-- DropForeignKey
ALTER TABLE "photos" DROP CONSTRAINT "photos_issue_id_fkey";

-- DropForeignKey
ALTER TABLE "register_entries" DROP CONSTRAINT "register_entries_previous_round_id_fkey";

-- DropForeignKey
ALTER TABLE "register_entries" DROP CONSTRAINT "register_entries_submission_id_fkey";

-- DropForeignKey
ALTER TABLE "submissions" DROP CONSTRAINT "submissions_supersedes_id_fkey";

-- CreateTable
CREATE TABLE "project_memory_versions" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "proposal_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_memory_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_proposals" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "base_content" TEXT,
    "proposed" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),

    CONSTRAINT "memory_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "running_since" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "failure" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_entries" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_memory_versions_proposal_id_key" ON "project_memory_versions"("proposal_id");

-- CreateIndex
CREATE INDEX "project_memory_versions_project_id_created_at_idx" ON "project_memory_versions"("project_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "memory_proposals_run_id_key" ON "memory_proposals"("run_id");

-- CreateIndex
CREATE INDEX "memory_proposals_project_id_created_at_idx" ON "memory_proposals"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_runs_project_id_created_at_idx" ON "agent_runs"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_entries_project_id_created_at_idx" ON "audit_entries"("project_id", "created_at");

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "submissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photos" ADD CONSTRAINT "photos_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "register_entries" ADD CONSTRAINT "register_entries_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "register_entries" ADD CONSTRAINT "register_entries_previous_round_id_fkey" FOREIGN KEY ("previous_round_id") REFERENCES "register_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_memory_versions" ADD CONSTRAINT "project_memory_versions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_memory_versions" ADD CONSTRAINT "project_memory_versions_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "memory_proposals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_proposals" ADD CONSTRAINT "memory_proposals_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_proposals" ADD CONSTRAINT "memory_proposals_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_entries" ADD CONSTRAINT "audit_entries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
