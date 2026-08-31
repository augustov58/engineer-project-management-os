-- Referenced files, issue #17 (MVP slice 16).
--
-- Four tables. A document is stored against a job with light metadata; its
-- bytes live in object storage under an immutable version; and it is reached
-- through the structure it belongs to — this project, this submission, this
-- register entry. Retrieval is by identity throughout (ADR-0019).
--
-- A **referenced file** is a document stored and linked but deliberately not
-- parsed: a drawing set, a spec book. An 86-sheet 48"x36" set is not an
-- extraction target, and "referenced_file" is what a future extraction pass
-- reads to leave it alone.
--
-- The bytes are not here. They go to the injected object store and
-- "document_versions" keeps the key, which is the ticket's own criterion and
-- the third record to use that port after a photograph and a recording.
--
-- What it deliberately does NOT do: no "referenced_files" table, though the
-- PRD's data model sketch names one beside "documents" and
-- "document_versions" — the glossary defines a referenced file as *a
-- document*, so a second table would make one document two records and give
-- "is this one?" two answers free to differ. It is a column, as
-- "issued_provisional" is. No column on "submissions" pointing at a document:
-- that could only be written after the set went out, and no route updates a
-- submission (ADR-0026) — the reason "register_entries"."submission_id"
-- points the way it does. No rows for the sheet list: ADR-0026 priced linking
-- a referenced file to *one sheet* as a migration off that text column, and
-- nothing in this ticket addresses a single sheet, so the link is to the
-- issuance and the text column stands. No extracted metadata — no document
-- number, no discipline, no document type — because nothing reads them until
-- step 5 and a column nothing writes is a column nobody can trust. **No
-- embedding, no vector column, no similarity ranking and no full-text index**
-- (ADR-0019); FTS5 is the named first escalation and its trigger has not
-- fired. No queue and no extraction job: nothing here reads a document's
-- contents, which is why this ticket is not gated on the employer consent
-- that gates the rest of step 5.

-- CreateTable
--
-- The identity and not the file: what the job calls it, and whether it is a
-- referenced file. Nothing that differs between one version and the next, so
-- a document reissued three times is one record with three versions rather
-- than three records that could disagree about what the document is. It is
-- the scope a version's "revision" is unique within, which is what
-- "registers" is to an entry's "number" (ADR-0036), and it carries no state.
--
-- "title" is not unique on a project. Two sets really can be called the same
-- thing, and a constraint here would refuse the second rather than the
-- mistake.
--
-- "referenced_file" is NOT NULL with no default. A default would classify by
-- omission and the omitted answer would be the dangerous one: between
-- recording and marking, a large-format set would be an extraction target.
-- Required in the body that records the document, and never edited after —
-- the shape "issued_provisional" has.
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "referenced_file" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- One immutable revision, in object storage. Nothing edits one and nothing
-- deletes one: a newer revision is a new row and the row it follows is not
-- touched, which is what makes "which version did we issue against"
-- answerable years later. ADR-0008's "the original file in S3 is immutable",
-- made structural.
--
-- "revision" is the designation printed on the sheet — ADR-0008's extracted
-- field of that name, entered by hand, which that ADR's own consequence names
-- as the path a failed extraction degrades to. The engineer's and never
-- allocated, as a register entry's number is.
--
-- "filename" is bookkeeping here and not the mechanism it is on a photograph
-- (ADR-0032): a document is reached through the structure it belongs to, so
-- nothing is parsed out of it.
CREATE TABLE "document_versions" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- What a submission's sheet list points at (story 95). The
-- "submission_open_items" shape: a row written after the issuance, which
-- writes nothing to the submission and therefore does not edit one.
--
-- It points at a **version**, which is what makes "which version did we issue
-- against" answerable, and not at a *sheet*. Many-to-many, as
-- "submission_open_items" is: one drawing set backs several issuances, and
-- one issuance's defined set is drawings and specs together.
CREATE TABLE "submission_document_versions" (
    "submission_id" TEXT NOT NULL,
    "document_version_id" TEXT NOT NULL,

    CONSTRAINT "submission_document_versions_pkey" PRIMARY KEY ("submission_id","document_version_id")
);

-- CreateTable
--
-- What a piece of correspondence arrived with, or was answered by (story 97).
-- The same shape, so a submittal package is found through the entry it was
-- logged as and never by remembering the filename.
CREATE TABLE "register_entry_document_versions" (
    "register_entry_id" TEXT NOT NULL,
    "document_version_id" TEXT NOT NULL,

    CONSTRAINT "register_entry_document_versions_pkey" PRIMARY KEY ("register_entry_id","document_version_id")
);

-- CreateIndex
CREATE INDEX "documents_project_id_created_at_idx" ON "documents"("project_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_storage_key_key" ON "document_versions"("storage_key");

-- CreateIndex
--
-- **This is "immutable" made a constraint.** A revision is unique within its
-- document, so recording "Rev C" a second time is refused by the database
-- rather than by a guard that can be forgotten — and there is no route that
-- could overwrite the first even if one were. The same designation on a
-- different document is another document's business.
CREATE UNIQUE INDEX "document_versions_document_id_revision_key" ON "document_versions"("document_id", "revision");

-- CreateIndex
CREATE INDEX "document_versions_document_id_created_at_idx" ON "document_versions"("document_id", "created_at");

-- CreateIndex
CREATE INDEX "submission_document_versions_document_version_id_idx" ON "submission_document_versions"("document_version_id");

-- CreateIndex
CREATE INDEX "register_entry_document_versions_document_version_id_idx" ON "register_entry_document_versions"("document_version_id");

-- AddForeignKey
--
-- RESTRICT on delete throughout, matching every other foreign key here.
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "submission_document_versions" ADD CONSTRAINT "submission_document_versions_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "submission_document_versions" ADD CONSTRAINT "submission_document_versions_document_version_id_fkey" FOREIGN KEY ("document_version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "register_entry_document_versions" ADD CONSTRAINT "register_entry_document_versions_register_entry_id_fkey" FOREIGN KEY ("register_entry_id") REFERENCES "register_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "register_entry_document_versions" ADD CONSTRAINT "register_entry_document_versions_document_version_id_fkey" FOREIGN KEY ("document_version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddConstraint
--
-- The document types the boundary admits, named here as well as in the body
-- schema for the reason a photograph's four are: the read route hands this
-- value straight to a browser as the response's content type, so a row
-- carrying "text/html" would be a page this product served under its own
-- origin. Refused underneath, not only at the edge.
--
-- Three and not four: a drawing set and a spec book arrive as PDF, and a spec
-- section or a schedule arrives as Word or Excel. Anything else is not a
-- document this ticket names, and widening the set is a migration rather than
-- a string a caller invents.
--
-- Written by hand because Prisma's schema language cannot express a CHECK.
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_content_type" CHECK ("content_type" IN (
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
));

-- AddConstraint
--
-- A version with no bytes is not a record of anything, and the byte count is
-- what a list renders without reading every object.
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_byte_size" CHECK ("byte_size" > 0);
