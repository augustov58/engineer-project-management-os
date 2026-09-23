-- A proposed Since is a date (issue #154, ADR-0064).
--
-- The model reads a date off the document and was asked for an instant, and
-- it is told no zone — so it wrote midnight UTC, and the confirmation screen
-- read that instant in the job's zone, as ADR-0054 says an instant is read.
-- West of UTC that is the evening before, and the pre-filled Since was a day
-- early. The column holds what the model actually knows.
--
-- Every existing value is read as its **UTC date**, which is the date the
-- model wrote. A column of `TIMESTAMP(3)` casts to its own date with no
-- session zone involved. Rows written before 2026-09-12 were shifted by
-- `20260912000000_project_timezone_and_real_instants` from midnight to four
-- or five hours after it, which is still the same UTC date. A value the model
-- wrote with an offset of its own is not recoverable from the column, because
-- the offset was never kept.

-- AlterTable
ALTER TABLE "register_entry_extractions"
  ALTER COLUMN "proposed_held_since" TYPE DATE USING "proposed_held_since"::date;
