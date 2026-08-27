-- Assumption records (issue #8). The durable artifact of engineering
-- reasoning: two blocks captured verbatim from a helper skill's output, bound
-- to the submission they justified. Nothing here computes anything — the
-- product records what a helper skill produced and never reimplements its math.

-- CreateTable
--
-- No default on either timestamp, for the reason nothing else here has one:
-- a domain-meaningful time may only come from the injected TimeSource
-- (ADR-0022). `assumptions` and `flags` are TEXT and stay byte-for-byte what
-- was captured — leading whitespace, blank lines and all.
CREATE TABLE "assumption_records" (
    "id" TEXT NOT NULL,
    "submission_id" TEXT NOT NULL,
    "assumptions" TEXT NOT NULL,
    "flags" TEXT NOT NULL,
    "code_edition" TEXT NOT NULL,
    "calculated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assumption_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- One counterfactual per assumed input, keyed by the line of the ASSUMPTIONS
-- block it is about. The block is never edited, so the line is a stable
-- pointer and the wording of an assumption lives in exactly one place.
CREATE TABLE "counterfactuals" (
    "assumption_record_id" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "counterfactual" TEXT NOT NULL,

    CONSTRAINT "counterfactuals_pkey" PRIMARY KEY ("assumption_record_id","line")
);

-- CreateTable
--
-- A flag raised as an open item, keyed the same way. The composite key is
-- what refuses raising one flag twice; `open_item_id` is unique below, which
-- is what refuses one item being two flags.
CREATE TABLE "raised_flags" (
    "assumption_record_id" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "open_item_id" TEXT NOT NULL,

    CONSTRAINT "raised_flags_pkey" PRIMARY KEY ("assumption_record_id","line")
);

-- CreateIndex
CREATE INDEX "assumption_records_submission_id_calculated_at_idx" ON "assumption_records"("submission_id", "calculated_at");

-- CreateIndex
CREATE UNIQUE INDEX "raised_flags_open_item_id_key" ON "raised_flags"("open_item_id");

-- AddForeignKey
--
-- RESTRICT on delete throughout, matching every other foreign key here:
-- nothing deletes a submission or an open item, and a record losing the
-- issuance it justified would be the erasure this table exists to prevent.
ALTER TABLE "assumption_records" ADD CONSTRAINT "assumption_records_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "counterfactuals" ADD CONSTRAINT "counterfactuals_assumption_record_id_fkey" FOREIGN KEY ("assumption_record_id") REFERENCES "assumption_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raised_flags" ADD CONSTRAINT "raised_flags_assumption_record_id_fkey" FOREIGN KEY ("assumption_record_id") REFERENCES "assumption_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raised_flags" ADD CONSTRAINT "raised_flags_open_item_id_fkey" FOREIGN KEY ("open_item_id") REFERENCES "open_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
