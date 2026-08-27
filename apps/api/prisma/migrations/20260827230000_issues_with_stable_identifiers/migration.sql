-- Issues with stable per-project identifiers (issue #10). An issue is a
-- project-scoped finding with an identifier that survives the report it first
-- appeared in, so a later visit can re-observe, reopen or close it.
--
-- Nothing is written to `observations`. ADR-0030 is explicit that becoming an
-- issue "will arrive as a row pointing at the observation, not as a column
-- here", and a test asserts the exact key set an observation returns — so the
-- link is a table, the shape `raised_flags` already has.

-- AlterTable
--
-- The high-water mark the identifiers come off (stories 58, 59). Not a count
-- of `issues`: `MAX(number) + 1` and `COUNT(*) + 1` both hand a number out
-- twice the moment a row goes away, and "never reused, including after an
-- issue is deleted" is the property being promised. This column only ever
-- increases, and the increment takes a row lock, so two promotions at once
-- serialise instead of racing.
--
-- A default, unlike every timestamp here: zero is not a domain-meaningful
-- time, it is where a project that has raised no issues starts, and the
-- existing rows need it (ADR-0022 is about the clock, not about counters).
ALTER TABLE "projects" ADD COLUMN "issues_allocated" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
--
-- No content of its own: what was seen, when and where belongs to the
-- observations, and an issue re-observed on three walks has three of them.
-- The PRD's sketch named a `location` here; it is read through the
-- observations instead, so the components and the string cannot come to
-- disagree and the one-axis CHECK is not duplicated onto a second table.
--
-- `closed_at` and `closure_note` move together — both null is open, both set
-- is closed, and reopening clears both. ADR-0024's shape for the same reason:
-- a status column would be a second place the same fact lives.
CREATE TABLE "issues" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "closed_at" TIMESTAMP(3),
    "closure_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issues_pkey" PRIMARY KEY ("id")
);

-- AddConstraint
--
-- The closed set of exactly five, in the words the glossary writes them
-- (story 60). "Enforce them in the schema, not only in the interface" is the
-- spec's own instruction, and this is that: the body schema refuses a sixth
-- at the boundary and this refuses it again underneath, the double
-- enforcement ADR-0030 gave the one-axis rule.
--
-- A CHECK rather than a database enum, because a Prisma enum member cannot be
-- named `Physical / Safety`. An enum would therefore put `PHYSICAL_SAFETY` on
-- the wire with the real words in a lookup table beside it, in the API and
-- again in the frontend — the second place the same fact lives that ADR-0024
-- refuses. Written by hand, as the one-axis CHECK is, because Prisma's schema
-- language can express neither.
ALTER TABLE "issues" ADD CONSTRAINT "issues_category" CHECK ("category" IN (
    'Accessibility',
    'Physical / Safety',
    'Functional',
    'Safety / Code',
    'Design / Coordination'
));

-- CreateTable
--
-- One sighting of a finding: the observation it was raised from, and every
-- later observation of the same thing (story 61). "Still there on the second
-- walk" is one of these rows, which is why the issue needs no history of its
-- own.
CREATE TABLE "issue_observations" (
    "issue_id" TEXT NOT NULL,
    "observation_id" TEXT NOT NULL,

    CONSTRAINT "issue_observations_pkey" PRIMARY KEY ("issue_id","observation_id")
);

-- CreateTable
--
-- An open item being chased for a finding (story 69). A join and not a
-- subject: the item's `subject_type` stays `PROJECT`, so it is on the project
-- screen and reaches the pending items view carrying the job it is on.
CREATE TABLE "issue_open_items" (
    "issue_id" TEXT NOT NULL,
    "open_item_id" TEXT NOT NULL,

    CONSTRAINT "issue_open_items_pkey" PRIMARY KEY ("issue_id","open_item_id")
);

-- CreateIndex
--
-- The identifier, and the whole of "never renumbered": the database refuses a
-- second issue with the same number on the same job rather than a guard that
-- can be forgotten.
CREATE UNIQUE INDEX "issues_project_id_number_key" ON "issues"("project_id", "number");

-- CreateIndex
--
-- One observation, at most one issue. A double-tap that promoted the same
-- sighting twice would burn an identifier on a duplicate and — since numbers
-- are never reused — leave the record permanently one issue heavier. Two
-- problems seen in one place are two observations.
CREATE UNIQUE INDEX "issue_observations_observation_id_key" ON "issue_observations"("observation_id");

-- CreateIndex
CREATE INDEX "issue_open_items_open_item_id_idx" ON "issue_open_items"("open_item_id");

-- AddForeignKey
--
-- RESTRICT on delete throughout, matching every other foreign key here.
-- Nothing in this product deletes anything, and an identifier that outlives
-- the report it was printed in cannot be allowed to lose the project that
-- scopes it.
ALTER TABLE "issues" ADD CONSTRAINT "issues_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_observations" ADD CONSTRAINT "issue_observations_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_observations" ADD CONSTRAINT "issue_observations_observation_id_fkey" FOREIGN KEY ("observation_id") REFERENCES "observations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_open_items" ADD CONSTRAINT "issue_open_items_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_open_items" ADD CONSTRAINT "issue_open_items_open_item_id_fkey" FOREIGN KEY ("open_item_id") REFERENCES "open_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
