-- Voice capture and the draft observation it becomes, issue #12 (MVP slice 11).
--
-- One table. A recording is made on a walk, its audio goes to the injected
-- object store, and a queued job asks the transcription vendor what was said.
-- What comes back is a **draft**: the engineer reads it, corrects it, and only
-- then does an observation exist.
--
-- The draft is this row and NOT a state of an observation. ADR-0030 put no
-- status on "observations", and a test asserts the exact key set one comes
-- back with; a "draft" column there would be that status under another name.
-- Committing INSERTs an ordinary observation and stamps "observation_id" here
-- — slice 9's shape, where promotion writes nothing at all to the row it
-- points at.
--
-- The audio is not here. It goes to the ObjectStore port and this table keeps
-- the key, which is the ticket's own criterion.
--
-- What it deliberately does NOT do: no CHECK on the two stamp pairs. This
-- schema does not constrain "resolved_at"/"resolution_note" or
-- "closed_at"/"closure_note" either — the routes are what move each pair
-- together, and a third pattern here would be this table claiming to be
-- stricter than the two records it copies.

-- CreateTable
--
-- "capture_key" is minted by the phone before it tries to send, and is what
-- makes a send retried after the signal returns land once rather than twice
-- (story 112). A photograph reconciles on its filename; a recording has no
-- natural name, so the phone supplies one.
--
-- "recorded_at" is required and never falls back to the clock, for
-- "photos"."taken_at"'s reason: a recording sent an hour later when the signal
-- came back would otherwise be stamped with the moment it arrived, and the
-- observation it becomes is dated from this.
--
-- The four stamps are the whole of the state. Queued is all four null;
-- "transcribing_since" is stamped when the worker picks the job up;
-- "transcript" and "transcribed_at" move together, as do "failed_at" and
-- "failure". Retrying clears the failure and the start, the way reopening an
-- issue clears its close.
CREATE TABLE "voice_captures" (
    "id" TEXT NOT NULL,
    "site_visit_id" TEXT NOT NULL,
    "capture_key" TEXT NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL,
    "content_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "transcribing_since" TIMESTAMP(3),
    "transcript" TEXT,
    "transcribed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "failure" TEXT,
    "observation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voice_captures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "voice_captures_storage_key_key" ON "voice_captures"("storage_key");

-- CreateIndex
--
-- One recording becomes at most one observation, which is the shape
-- "issue_observations"."observation_id" has and for its reason: a double tap
-- that committed twice would write the same words into the record twice.
CREATE UNIQUE INDEX "voice_captures_observation_id_key" ON "voice_captures"("observation_id");

-- CreateIndex
--
-- The walk's recordings in the order they were made, which is the order the
-- walk happened in and the order the review list reads in.
CREATE INDEX "voice_captures_site_visit_id_recorded_at_idx" ON "voice_captures"("site_visit_id", "recorded_at");

-- CreateIndex
--
-- The reconciliation mechanism itself. The route answers a repeat with the row
-- it already has rather than a refusal — unlike a photograph's filename, where
-- a refusal is the right answer — because a refusal does not tell the phone
-- whether the first attempt landed, and "without losing a recording" is what
-- story 112 asks for.
CREATE UNIQUE INDEX "voice_captures_site_visit_id_capture_key_key" ON "voice_captures"("site_visit_id", "capture_key");

-- AddForeignKey
--
-- RESTRICT on delete throughout, matching every other foreign key here.
ALTER TABLE "voice_captures" ADD CONSTRAINT "voice_captures_site_visit_id_fkey" FOREIGN KEY ("site_visit_id") REFERENCES "site_visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_captures" ADD CONSTRAINT "voice_captures_observation_id_fkey" FOREIGN KEY ("observation_id") REFERENCES "observations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddConstraint
--
-- The audio types the boundary admits, named here as well as in the body
-- schema for the reason the image types are: the read route hands this value
-- straight to a browser as the response's content type, so a row carrying
-- "text/html" would be a page this product served under its own origin.
--
-- Exactly three, because exactly three are what a phone browser produces —
-- Chrome and Android give WebM, Safari and iOS give MP4, Firefox gives Ogg.
-- Nothing else can arrive from the one place recordings are made.
--
-- Written by hand because Prisma's schema language cannot express a CHECK.
ALTER TABLE "voice_captures" ADD CONSTRAINT "voice_captures_content_type" CHECK ("content_type" IN (
    'audio/webm',
    'audio/mp4',
    'audio/ogg'
));

-- AddConstraint
--
-- A recording with no bytes is not a recording of anything, and the byte count
-- is what a list renders without reading every object.
ALTER TABLE "voice_captures" ADD CONSTRAINT "voice_captures_byte_size" CHECK ("byte_size" > 0);
