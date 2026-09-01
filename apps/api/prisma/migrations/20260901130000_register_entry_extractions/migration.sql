-- CreateTable
CREATE TABLE "register_entry_extractions" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "ingested_document_file_id" TEXT,
    "document_version_id" TEXT,
    "ocr_text" TEXT,
    "running_since" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "failure" TEXT,
    "proposed_kind" "register_kind",
    "proposed_at" TIMESTAMP(3),
    "proposed_number" TEXT,
    "proposed_subject" TEXT,
    "proposed_from_party" TEXT,
    "proposed_to_party" TEXT,
    "proposed_question" TEXT,
    "proposed_response" TEXT,
    "proposed_turnaround_days" INTEGER,
    "proposed_party" TEXT,
    "proposed_in_our_court" BOOLEAN,
    "proposed_held_since" TIMESTAMP(3),
    "proposed_title" TEXT,
    "proposed_revision" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "register_entry_id" TEXT,
    "rejected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "register_entry_extractions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "register_entry_extractions_register_entry_id_key" ON "register_entry_extractions"("register_entry_id");

-- CreateIndex
CREATE INDEX "register_entry_extractions_project_id_created_at_idx" ON "register_entry_extractions"("project_id", "created_at");

-- AddForeignKey
ALTER TABLE "register_entry_extractions" ADD CONSTRAINT "register_entry_extractions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "register_entry_extractions" ADD CONSTRAINT "register_entry_extractions_ingested_document_file_id_fkey" FOREIGN KEY ("ingested_document_file_id") REFERENCES "ingested_document_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "register_entry_extractions" ADD CONSTRAINT "register_entry_extractions_document_version_id_fkey" FOREIGN KEY ("document_version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "register_entry_extractions" ADD CONSTRAINT "register_entry_extractions_register_entry_id_fkey" FOREIGN KEY ("register_entry_id") REFERENCES "register_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exactly one source: one file of an arrival, or one version of a stored
-- document (ADR-0043). Enforced here and not only at the boundary for
-- ADR-0030's reason: the two never combining is a property of the record,
-- not a habit of the interface.
ALTER TABLE "register_entry_extractions" ADD CONSTRAINT "register_entry_extractions_one_source"
CHECK (("ingested_document_file_id" IS NULL) <> ("document_version_id" IS NULL));
