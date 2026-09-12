-- AlterTable: the zone of the building each job is at (issue #104, ADR-0054).
--
-- Added nullable, backfilled, then made NOT NULL — the shape
-- 20260901120000_ingest_address_and_arrivals used for "ingest_token", so an
-- existing database keeps its projects. `SET NOT NULL` **is** the refusal the
-- ticket asks for: it fails, and the migration with it, if any project would
-- be left without a zone. A guard above it would be a second place the same
-- fact lives, and the weaker of the two.
--
-- America/New_York for every existing row, confirmed by the author as right
-- for every project in the database today (ADR-0054). Required with no default
-- from here on: the route refuses a create without one.
ALTER TABLE "projects" ADD COLUMN "timezone" TEXT;

UPDATE "projects" SET "timezone" = 'America/New_York' WHERE "timezone" IS NULL;

ALTER TABLE "projects" ALTER COLUMN "timezone" SET NOT NULL;

-- Every stored DateTime becomes a real instant (ADR-0054, superseding
-- ADR-0050).
--
-- Until now a typed day and clock time were composed as `${day}T${time}:00.000Z`
-- — the engineer's wall clock relabelled UTC — while everything the injected
-- TimeSource stamped was a true instant. The two frames differ by the
-- engineer's offset, which is how a floor window started by the blank-time
-- path came to bin no photograph at all (issue #97). This moves the typed
-- values into the frame the stamped ones were always in.
--
-- **Which way.** The stored value *is* the wall clock, so it is read as local
-- time in the zone and written back as the UTC face of that instant:
-- `(col AT TIME ZONE zone) AT TIME ZONE 'UTC'`. New York in July moves four
-- hours forward, in January five, and Postgres reads the daylight-saving
-- history per row rather than applying one offset to all of them.
--
-- **Which rows.** A typed value was always written with `:00.000` seconds, and
-- a clock stamp lands there about one time in sixty thousand, so seconds and
-- milliseconds both zero is the test — `date_part('second', col)` carries the
-- fraction, so the one predicate covers both. `photos.taken_at` is shifted
-- unconditionally: it was a real instant (a file's `lastModified`) that
-- `asTypedInstant` corrupted into the fake frame so that it would bin against
-- typed windows, so every one of them is wrong by exactly the same offset.
--
-- **Which columns.** Only the typed-capable ones — the fourteen `instant()`
-- fills and the five a client supplies outright. The other thirty-eight are
-- purely server-stamped (`created_at`, the worker's four-stamp state columns,
-- the audit) and are already real instants; touching one would move it.
--
-- **Why a constant and not a join to `projects.timezone`.** Every project is
-- set to America/New_York three statements above, so a correlated lookup would
-- compute that same constant sixteen times over five different join paths. The
-- constant is what the zone column holds at this point in the chain; a project
-- created after this migration gets its zone from the route.
--
-- This is a one-off, and ADR-0054 says so in as many words: no real walk has
-- been recorded yet, so every row here is test-drive data or a 260001 open
-- item. **After the first real walk this answer flips** — a later frame defect
-- is a dated correction, never a rewrite.
DO $$
DECLARE
  zone text := 'America/New_York';
  typed text[][] := ARRAY[
    ['projects', 'cloud_signoff_at'],
    ['submissions', 'issued_at'],
    ['open_items', 'waiting_since'],
    ['open_items', 'resolved_at'],
    ['assumption_records', 'calculated_at'],
    ['site_visits', 'started_at'],
    ['site_visits', 'ended_at'],
    ['site_visit_floors', 'started_at'],
    ['site_visit_floors', 'completed_at'],
    ['observations', 'observed_at'],
    ['issues', 'closed_at'],
    ['voice_captures', 'recorded_at'],
    ['register_entries', 'disposed_at'],
    ['ball_in_court_events', 'held_since'],
    ['register_entry_extractions', 'proposed_held_since']
  ];
  pair text[];
  shifted integer;
BEGIN
  FOREACH pair SLICE 1 IN ARRAY typed LOOP
    EXECUTE format(
      'UPDATE %I SET %I = (%I AT TIME ZONE %L) AT TIME ZONE ''UTC''
         WHERE %I IS NOT NULL AND date_part(''second'', %I) = 0',
      pair[1], pair[2], pair[2], zone, pair[2], pair[2]
    );
    GET DIAGNOSTICS shifted = ROW_COUNT;
    RAISE NOTICE 'shifted % row(s): %.%', shifted, pair[1], pair[2];
  END LOOP;

  -- Every one of them, and not only the ones written on a whole minute: a
  -- file's timestamp carries real seconds and was shifted all the same.
  EXECUTE format(
    'UPDATE "photos" SET "taken_at" = ("taken_at" AT TIME ZONE %L) AT TIME ZONE ''UTC''',
    zone
  );
  GET DIAGNOSTICS shifted = ROW_COUNT;
  RAISE NOTICE 'shifted % row(s): photos.taken_at', shifted;
END $$;

-- Floor binding is re-run against the shifted values (ADR-0054).
--
-- A photograph binds to a floor **iff exactly one** per-floor window contains
-- its timestamp, both ends inclusive and open-ended while the floor is still
-- being walked (ADR-0032). Zero windows and two windows are equally unbound,
-- because picking one of two is the guess the zero case refuses.
--
-- Written here rather than run through the route because the route stamps a
-- binding when a photograph is *added* and corrects it in one action — there
-- is no re-bind route, and inventing one to run this once would be a second
-- way a binding is written. The rule is `binToFloor` in
-- `src/routes/photos.ts`, and this is the only other place it is spelled; it
-- ran once, against rows that have never been in front of anybody.
--
-- A binding the engineer cleared by hand is overwritten, which is the one
-- thing this cannot tell apart: there is no provenance column, deliberately,
-- so "the engineer cleared it" and "no window contained it" are the same
-- stored fact (ADR-0032). Nobody has cleared one — no walk has been recorded.
WITH bound AS (
  SELECT
    "photos"."id",
    (
      -- `min` because the HAVING below already fixes the set at one row; it is
      -- that row's floor and never a choice between two.
      SELECT min("window"."floor")
      FROM "site_visit_floors" AS "window"
      WHERE "window"."site_visit_id" = "photos"."site_visit_id"
        AND "window"."started_at" <= "photos"."taken_at"
        AND (
          "window"."completed_at" IS NULL
          OR "photos"."taken_at" <= "window"."completed_at"
        )
      -- Exactly one, or nothing: two matching windows leave it unbound.
      HAVING count(*) = 1
    ) AS "floor"
  FROM "photos"
)
UPDATE "photos"
SET "floor" = "bound"."floor"
FROM "bound"
WHERE "photos"."id" = "bound"."id"
  AND "photos"."floor" IS DISTINCT FROM "bound"."floor";
