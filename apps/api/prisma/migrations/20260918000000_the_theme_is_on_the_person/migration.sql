-- The theme is on the person, not in the browser (issue #117, ADR-0059
-- point 4 as the design brief extends it).
--
-- ADR-0059 said the dark theme activates by system preference. The brief's
-- decision 2, approved 2026-09-17, adds an override beside it: System / Light
-- / Dark, stored on the user so it follows the engineer from the phone on the
-- walk to the desk afterwards. A cookie would not; it would be per browser,
-- which is the thing being ruled out.
--
-- SYSTEM is the default and is not a third colour. It is the absence of an
-- override, which leaves "prefers-color-scheme" to answer, so an account made
-- before this migration and an account made after it read the same.

-- CreateEnum
CREATE TYPE "theme" AS ENUM ('SYSTEM', 'LIGHT', 'DARK');

-- AlterTable
--
-- A default on a preference, unlike a default on a domain timestamp, is not
-- the database supplying a domain-meaningful value (ADR-0022): nothing ages
-- off it and nothing is derived from it.
ALTER TABLE "users" ADD COLUMN "theme" "theme" NOT NULL DEFAULT 'SYSTEM';
