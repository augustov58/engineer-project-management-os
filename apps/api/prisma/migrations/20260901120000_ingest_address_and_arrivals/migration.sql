-- The ingest address and untrusted inbound mail, issue #19 (MVP slice 18).
--
-- One column and two tables. Each job gets a high-entropy forward-to-ingest
-- token; a message forwarded to it becomes a raw arrival with its source and
-- the time it reached us; and the files it carried go to the object store.
--
-- This slice stops at the raw arrival. Extraction is issue #20. Nothing here
-- parses, extracts, indexes or summarises a document: there is no job name,
-- no worker branch, and nothing an arrival enqueues, which is what makes
-- "inbound content is never interpreted as instructions" true by there being
-- nothing that could interpret it (ADR-0042, story 89).
--
-- The consent gate is NOT lifted. The inbound mail provider sits behind a
-- port with no adapter written — the default refuses, as the transcription
-- vendor's does (ADR-0034) — so nothing leaves this process and no message
-- reaches a third party. The gate fires on writing that adapter.
--
-- What it deliberately does NOT do: no ingest columns on "documents". Three
-- of that record's are load-bearing and have no answer when a message lands —
-- "referenced_file" is required with no default because a default classifies
-- by omission (ADR-0039), and "revision" and the title are the engineer's and
-- never allocated. Inventing all three and calling them facts is what 0039
-- refused; they are extraction's to propose and the engineer's to confirm.
-- No closed content-type set, unlike "document_versions"' three: refusing a
-- .dwg would lose the record that the manual fallback exists to protect, and
-- the served-under-our-origin hole 0039 named is closed at the read instead,
-- where the bytes route answers "application/octet-stream" always. No
-- "attachments" anywhere — that word is struck by three of the glossary's
-- _Avoid_ lists, so the child rows are files. No column named for the project
-- number in the address: ADR-0009 sketched "rfi+{project-key}@..." and an
-- address built from "T-1" is guessable, which story 83 forbids. No rate
-- limit counter table and no Redis key: the limit is a count of the rows
-- already here, dated by the column below (ADR-0042). No "processing_location"
-- setting — that is stories 91-92 and a contradiction the vault still records
-- as open.

-- AlterTable: the secret half of each job's ingest address.
--
-- Added nullable, backfilled, then made NOT NULL and unique, so an existing
-- database keeps its projects. The backfill uses gen_random_uuid(), which is
-- built in on PostgreSQL 13+ and cryptographically random; two of them give
-- 256 bits, which is above the 192 the API generates for a new row. random()
-- is deliberately not used: it is not a cryptographic source, and this column
-- is the only credential on a path that bypasses the interface entirely.
ALTER TABLE "projects" ADD COLUMN "ingest_token" TEXT;

UPDATE "projects"
SET "ingest_token" = replace(gen_random_uuid()::text, '-', '')
                  || replace(gen_random_uuid()::text, '-', '')
WHERE "ingest_token" IS NULL;

ALTER TABLE "projects" ALTER COLUMN "ingest_token" SET NOT NULL;

CREATE UNIQUE INDEX "projects_ingest_token_key" ON "projects"("ingest_token");

-- CreateEnum
CREATE TYPE "ingest_source" AS ENUM ('EMAIL', 'MANUAL');

-- CreateTable
CREATE TABLE "ingested_documents" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "source" "ingest_source" NOT NULL,
    "arrived_at" TIMESTAMP(3) NOT NULL,
    "sender" TEXT,
    "recipient" TEXT,
    "subject" TEXT,
    "body" TEXT,
    "note" TEXT,

    CONSTRAINT "ingested_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingested_document_files" (
    "id" TEXT NOT NULL,
    "ingested_document_id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ingested_document_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ingested_documents_project_id_arrived_at_idx" ON "ingested_documents"("project_id", "arrived_at");

-- CreateIndex
CREATE UNIQUE INDEX "ingested_document_files_storage_key_key" ON "ingested_document_files"("storage_key");

-- CreateIndex
CREATE INDEX "ingested_document_files_ingested_document_id_created_at_idx" ON "ingested_document_files"("ingested_document_id", "created_at");

-- AddForeignKey
-- RESTRICT on delete throughout, matching every other foreign key here.
ALTER TABLE "ingested_documents" ADD CONSTRAINT "ingested_documents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingested_document_files" ADD CONSTRAINT "ingested_document_files_ingested_document_id_fkey" FOREIGN KEY ("ingested_document_id") REFERENCES "ingested_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What "the same record shape" means, held by the database rather than by the
-- two writers agreeing (ADR-0042, criterion 5). One table, one set of columns,
-- and which of them are filled is a function of the source: the mail path
-- carries an envelope and the engineer's hand does not.
--
-- A message with no subject and no body is ordinary and both stay nullable;
-- an arrival from the mail path with no sender or no recipient is not, because
-- the recipient is the address that was written to and the record would not be
-- able to say which one received it.
ALTER TABLE "ingested_documents" ADD CONSTRAINT "ingested_documents_email_has_an_envelope" CHECK (
    "source" <> 'EMAIL' OR ("sender" IS NOT NULL AND "recipient" IS NOT NULL AND "note" IS NULL)
);

ALTER TABLE "ingested_documents" ADD CONSTRAINT "ingested_documents_manual_has_no_envelope" CHECK (
    "source" <> 'MANUAL' OR ("sender" IS NULL AND "recipient" IS NULL AND "subject" IS NULL AND "body" IS NULL)
);

-- A stored file has bytes, as a photograph, a recording and a document version
-- each do.
ALTER TABLE "ingested_document_files" ADD CONSTRAINT "ingested_document_files_byte_size" CHECK ("byte_size" > 0);
