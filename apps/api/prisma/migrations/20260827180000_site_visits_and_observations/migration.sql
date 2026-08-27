-- Site visits and observations (issue #9). A site visit is one dated
-- observation event against a building, with a start, an end and a per-floor
-- schedule; it produces observations and does not own their content.
--
-- Nothing here becomes a finding. Staying an observation is the default path
-- and the majority case — the "Notable Observations (Non-Issues)" table —
-- so there is no status column, and becoming an issue is ticket #10.

-- CreateTable
--
-- No default on any timestamp, for the reason nothing else here has one: a
-- domain-meaningful time may only come from the injected TimeSource
-- (ADR-0022). `ended_at` is nullable because the per-floor schedule is
-- recorded during the visit, so a walk exists before it is over. The visit's
-- date is the day of `started_at`, derived on read and stored nowhere.
CREATE TABLE "site_visits" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- One floor's window in time: when it was started and when it was completed.
-- This is what a photograph's timestamp is binned against (issue #11), which
-- is the whole of its job — it is a window, not a location. `floor` is free
-- text so a basement, a mezzanine or a penthouse can be walked (ADR-0030).
CREATE TABLE "site_visit_floors" (
    "id" TEXT NOT NULL,
    "site_visit_id" TEXT NOT NULL,
    "floor" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "site_visit_floors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- The location is stored as the components of the grammar
-- `Floor N — <qualifier>, <Side|Sector>` and never as the composed string, so
-- the two cannot come to disagree — the string is rendered on every read.
-- Side and Sector are independent axes; the CHECK below is what stops them
-- combining.
CREATE TABLE "observations" (
    "id" TEXT NOT NULL,
    "site_visit_id" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "floor" TEXT NOT NULL,
    "qualifier" TEXT NOT NULL,
    "side" TEXT,
    "sector" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "observations_pkey" PRIMARY KEY ("id")
);

-- AddConstraint
--
-- Exactly one of side or sector, which is story 55 — "so that the location
-- grammar cannot be corrupted by the interface" — made an invariant rather
-- than a guard. `<>` on the two null tests is true only when precisely one is
-- set: both set and neither set are equally refused, because the grammar has
-- no optional segment.
--
-- Written by hand because Prisma's schema language cannot express a CHECK.
-- Three more routes will write this table (#10's re-observation, #12's draft
-- from a transcript), and each of them would otherwise have to remember.
ALTER TABLE "observations" ADD CONSTRAINT "observations_one_axis"
    CHECK (("side" IS NULL) <> ("sector" IS NULL));

-- CreateIndex
CREATE INDEX "site_visits_project_id_started_at_idx" ON "site_visits"("project_id", "started_at");

-- CreateIndex
--
-- One row per floor per visit. Starting the same floor twice on one walk is
-- refused by the database rather than by a guard that can be forgotten, which
-- is the shape `supersedes_id` and `raised_flags.open_item_id` already have.
CREATE UNIQUE INDEX "site_visit_floors_site_visit_id_floor_key" ON "site_visit_floors"("site_visit_id", "floor");

-- CreateIndex
CREATE INDEX "observations_site_visit_id_observed_at_idx" ON "observations"("site_visit_id", "observed_at");

-- AddForeignKey
--
-- RESTRICT on delete throughout, matching every other foreign key here:
-- nothing deletes a project or a visit, and an observation losing the walk
-- that produced it would be the erasure these tables exist to prevent.
ALTER TABLE "site_visits" ADD CONSTRAINT "site_visits_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_visit_floors" ADD CONSTRAINT "site_visit_floors_site_visit_id_fkey" FOREIGN KEY ("site_visit_id") REFERENCES "site_visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "observations" ADD CONSTRAINT "observations_site_visit_id_fkey" FOREIGN KEY ("site_visit_id") REFERENCES "site_visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
