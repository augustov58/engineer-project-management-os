-- CreateEnum
CREATE TYPE "processing_location" AS ENUM ('LOCAL', 'CLOUD');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "cloud_signoff_at" TIMESTAMP(3),
ADD COLUMN     "cloud_signoff_reference" TEXT,
ADD COLUMN     "processing_location" "processing_location" NOT NULL DEFAULT 'CLOUD';

-- A written sign-off is a reference and a date together, or neither (issue
-- #21, story 92). ADR-0024's shape for `resolved_at` and ADR-0031's for a
-- closure, arriving for a third pairing.
--
-- What this CHECK deliberately does NOT say is "CLOUD implies a sign-off".
-- ADR-0013 makes cloud the default, so a project reaches `CLOUD` without
-- anybody having switched it and with nothing to record; that invariant is
-- false by design and only the route can gate the switch (ADR-0044). Under
-- the glossary's rejected local-default reading it would have been a CHECK,
-- and losing it is the price of the resolution.
ALTER TABLE "projects" ADD CONSTRAINT "projects_cloud_signoff_is_paired"
CHECK (("cloud_signoff_reference" IS NULL) = ("cloud_signoff_at" IS NULL));
