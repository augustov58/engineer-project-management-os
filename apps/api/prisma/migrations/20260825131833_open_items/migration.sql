-- CreateEnum
CREATE TYPE "open_item_subject" AS ENUM ('PROJECT');

-- CreateTable
CREATE TABLE "open_items" (
    "id" TEXT NOT NULL,
    "subject_type" "open_item_subject" NOT NULL,
    "subject_id" TEXT NOT NULL,
    "unresolved" TEXT NOT NULL,
    "blocks" TEXT NOT NULL,
    "waiting_on" TEXT,
    "waiting_since" TIMESTAMP(3) NOT NULL,
    "invalidation_trigger" TEXT,
    "counterfactual" TEXT NOT NULL,
    "owner" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolution_note" TEXT,

    CONSTRAINT "open_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "open_items_subject_type_subject_id_idx" ON "open_items"("subject_type", "subject_id");
