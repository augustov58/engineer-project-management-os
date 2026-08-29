-- The site visit report, issue #13 (MVP slice 12).
--
-- One table. A walk is asked for its write-up, a queued job renders the visit
-- to HTML and Chrome prints that to PDF, and the bytes go to the injected
-- object store. The row is what the screen watches while it happens and what
-- the finished document is read back through.
--
-- It is a record of a **rendering**, not a document anybody edits. Nothing
-- updates it once it has finished: generating again INSERTs another row
-- against the same visit, dated its own moment — a rerun of a calculation is
-- another assumption record (ADR-0029) and a correction to a submission is a
-- reissue (ADR-0028), and this is those. It is also how a report is
-- regenerated after a missing photograph is added, which is why there is no
-- retry route here and no cleared stamp: a recording is retried in place
-- because its audio is irreplaceable, and a report's every input is still in
-- the database.
--
-- It owns no content. Everything it prints — the metadata, the non-issue
-- observations, the findings sighted on this walk with their categories,
-- locations and photographs — is read at the moment it renders. There is no
-- copy of any of it here, so a report cannot come to disagree with the record
-- it is a rendering of. What it froze is the PDF.
--
-- What it deliberately does NOT do: no "content_type" column. A photograph and
-- a recording each carry one because either could arrive as one of several
-- types; a report is always "application/pdf", and a column holding one value
-- forever is a place for it to one day hold another. No CHECK on the stamp
-- pairs either, for the reason "voice_captures" has none: the routes move each
-- pair together, and a third pattern here would be this table claiming to be
-- stricter than the records it copies.

-- CreateTable
--
-- The four stamps are the whole of the state, in the shape ADR-0034 gave a
-- voice capture. Queued is all four null; "rendering_since" is stamped when
-- the worker picks the job up; "storage_key" and "rendered_at" move together,
-- as do "failed_at" and "failure". Queued, rendering, rendered and failed are
-- derived on every read and stored nowhere.
--
-- There is no status column beside them. ADR-0024 made "resolved_at" being
-- null the whole of *unresolved* and said not to add one; ADR-0031 made
-- "closed_at" the whole of *closed* and said it again; ADR-0034 said it a
-- third time. This is the fourth record to be asked and the fourth to refuse.
--
-- "storage_key" is nullable because a report exists before its bytes do —
-- unlike a photograph's and a recording's, whose bytes are written before the
-- row that points at them. The queue is between the two here, so the row comes
-- first and the key arrives with the rendering that produced it. The invariant
-- ADR-0032 was protecting still holds either way: no key is ever stored
-- pointing at bytes that are not there.
CREATE TABLE "site_visit_reports" (
    "id" TEXT NOT NULL,
    "site_visit_id" TEXT NOT NULL,
    "rendering_since" TIMESTAMP(3),
    "rendered_at" TIMESTAMP(3),
    "storage_key" TEXT,
    "byte_size" INTEGER,
    "failed_at" TIMESTAMP(3),
    "failure" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_visit_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "site_visit_reports_storage_key_key" ON "site_visit_reports"("storage_key");

-- CreateIndex
--
-- A walk's reports in the order they were asked for, which is the order they
-- list in and which makes the newest the last of them. Entry order and not
-- "rendered_at": a report that failed was still generated, and one still
-- rendering has no other time to be sorted by.
CREATE INDEX "site_visit_reports_site_visit_id_created_at_idx" ON "site_visit_reports"("site_visit_id", "created_at");

-- AddForeignKey
--
-- RESTRICT on delete throughout, matching every other foreign key here.
ALTER TABLE "site_visit_reports" ADD CONSTRAINT "site_visit_reports_site_visit_id_fkey" FOREIGN KEY ("site_visit_id") REFERENCES "site_visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddConstraint
--
-- A rendered report with no bytes is not a document, and the byte count is
-- what a list renders without reading every object. Guarded rather than left
-- to the route, matching "photos" and "voice_captures" — and nullable here,
-- because the count arrives with the rendering rather than with the row.
ALTER TABLE "site_visit_reports" ADD CONSTRAINT "site_visit_reports_byte_size" CHECK ("byte_size" > 0);
