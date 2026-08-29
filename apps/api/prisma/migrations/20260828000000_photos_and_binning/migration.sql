-- Photographs and the two bindings, issue #11 (MVP slice 10).
--
-- One table. A photograph is added to a walk, binned to a floor by its
-- timestamp against the per-floor schedule ADR-0030 built for exactly this,
-- and bound to a finding by the filename grammar the engineer already uses.
-- The two mechanisms are independent, so either, both or neither may land.
--
-- The bytes are not here. They go to the injected object store and this table
-- keeps the key, which is the ticket's own criterion: "photos are stored in
-- object storage, not in the database".
--
-- What it deliberately does NOT do: no `photo_observations` join — photo
-- evidence lands on the floor and on the finding, not on the observation, and
-- ADR-0032 records why. No queue: the mermaid in the PRD puts binning on a
-- worker, and it is date-and-string matching that takes microseconds.

-- CreateTable
--
-- `filename` is record content and not bookkeeping: it is the mechanism, so
-- nothing rewrites it and it is unique per visit, which makes re-adding the
-- same hundred photographs after a signal drop a refusal rather than a
-- doubled walk.
--
-- `floor` is the designation and not a foreign key to "site_visit_floors",
-- matching "observations"."floor" — ADR-0030 joined those two by value so a
-- photograph's floor could sit beside the observations made on it, and a
-- correction must be able to name a floor nobody formally started.
--
-- `issue_id` is nullable and stays nullable: a filename that matches no issue
-- on this job is left unbound rather than guessed at.
CREATE TABLE "photos" (
    "id" TEXT NOT NULL,
    "site_visit_id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "taken_at" TIMESTAMP(3) NOT NULL,
    "content_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "floor" TEXT,
    "issue_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "photos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "photos_storage_key_key" ON "photos"("storage_key");

-- CreateIndex
--
-- The walk's photographs in the order they were taken, which is the order a
-- schedule is read in and the order the report (#13) will print them in.
CREATE INDEX "photos_site_visit_id_taken_at_idx" ON "photos"("site_visit_id", "taken_at");

-- CreateIndex
--
-- What a finding's photo evidence *is*: the rows pointing at it, whose length
-- is the count. The view story 66 asks for reads the absence of these.
CREATE INDEX "photos_issue_id_idx" ON "photos"("issue_id");

-- CreateIndex
CREATE UNIQUE INDEX "photos_site_visit_id_filename_key" ON "photos"("site_visit_id", "filename");

-- AddForeignKey
--
-- RESTRICT on delete throughout, matching every other foreign key here.
ALTER TABLE "photos" ADD CONSTRAINT "photos_site_visit_id_fkey" FOREIGN KEY ("site_visit_id") REFERENCES "site_visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photos" ADD CONSTRAINT "photos_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddConstraint
--
-- The image types the boundary admits, named here as well as in the body
-- schema for the reason the issue category is: the read route hands this
-- value straight to a browser as the response's content type, so a row
-- carrying "text/html" would be a page this product served under its own
-- origin. Refused underneath, not only at the edge.
--
-- Written by hand because Prisma's schema language cannot express a CHECK.
ALTER TABLE "photos" ADD CONSTRAINT "photos_content_type" CHECK ("content_type" IN (
    'image/jpeg',
    'image/png',
    'image/heic',
    'image/webp'
));

-- AddConstraint
--
-- A photograph with no bytes is not a record of anything, and the byte count
-- is what a list renders without reading every object.
ALTER TABLE "photos" ADD CONSTRAINT "photos_byte_size" CHECK ("byte_size" > 0);
