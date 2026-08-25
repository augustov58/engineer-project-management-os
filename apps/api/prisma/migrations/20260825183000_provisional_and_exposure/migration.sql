-- Provisional is two facts, not one (issue #6). This adds the half that is
-- stored: what was true at the moment the set went out. The derived half —
-- whether anything it rests on is unresolved right now — is computed on read
-- and has no column anywhere.

-- AlterTable
--
-- Written by hand rather than generated. `issued_provisional` carries no
-- default in the schema, for the reason the timestamps carry none (ADR-0022):
-- the database must not be able to supply a domain-meaningful value. The
-- default below exists only to fill the rows already there, and is dropped in
-- the same transaction, so no later insert can omit it.
ALTER TABLE "submissions" ADD COLUMN "issued_provisional" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "submissions" ALTER COLUMN "issued_provisional" DROP DEFAULT;

-- AlterTable
--
-- Nullable on purpose, and the null means something: an open item attached
-- after the issuance was no part of it. Rows already here predate the
-- snapshot, so null is also the honest value for them.
ALTER TABLE "submission_open_items" ADD COLUMN "unresolved_at_issuance" BOOLEAN;
