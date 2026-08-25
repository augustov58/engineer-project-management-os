-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "current_phase_id" TEXT;

-- CreateTable
CREATE TABLE "project_phases" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "project_phases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submissions" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "phase_id" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL,
    "recipient" TEXT NOT NULL,
    "recipient_role" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    "sheet_list" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_open_items" (
    "submission_id" TEXT NOT NULL,
    "open_item_id" TEXT NOT NULL,

    CONSTRAINT "submission_open_items_pkey" PRIMARY KEY ("submission_id","open_item_id")
);

-- CreateIndex
CREATE INDEX "project_phases_project_id_position_idx" ON "project_phases"("project_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "project_phases_project_id_name_key" ON "project_phases"("project_id", "name");

-- CreateIndex
CREATE INDEX "submissions_project_id_issued_at_idx" ON "submissions"("project_id", "issued_at");

-- CreateIndex
CREATE INDEX "submission_open_items_open_item_id_idx" ON "submission_open_items"("open_item_id");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_current_phase_id_fkey" FOREIGN KEY ("current_phase_id") REFERENCES "project_phases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_phases" ADD CONSTRAINT "project_phases_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_phase_id_fkey" FOREIGN KEY ("phase_id") REFERENCES "project_phases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_open_items" ADD CONSTRAINT "submission_open_items_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_open_items" ADD CONSTRAINT "submission_open_items_open_item_id_fkey" FOREIGN KEY ("open_item_id") REFERENCES "open_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
