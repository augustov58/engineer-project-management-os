-- A failed sign-in is a record, and the throttle counts it (issue #125,
-- ADR-0062).
--
-- ADR-0055 left `POST /v1/sessions` with no rate limit and named exactly why it
-- could not just add one: "a failed sign-in writes nothing today, because a
-- refused write writes no audit line, so there is nothing to count". ADR-0042's
-- limit on the ingest address counts rows that already exist for their own
-- reasons and explicitly refuses a counter beside them. This table is what makes
-- that same arithmetic possible here.
--
-- It is not an audit line and could not become one. Nothing is mutated by a
-- refused sign-in, the caller has no session and so has no actor, and
-- `audit_entries.actor_id` is read from the session the gate validated and never
-- from a request body.
--
-- There is no password column and there will not be one. A table of near-misses
-- to a real password is worth nothing to anybody who is allowed to read it and a
-- great deal to anybody who is not, and `export.test.ts` searches the whole
-- exported document for `$argon2id$`.

-- CreateTable
CREATE TABLE "sign_in_failures" (
    "id" TEXT NOT NULL,

    -- The address exactly as presented, and deliberately not a link to
    -- `users`. An address naming no account still has to be counted — that is
    -- how a stranger spraying one password across guessed addresses is
    -- bounded — and writing a row only when the account exists would restore
    -- the known/unknown asymmetry `unmatchableHash()` exists to remove.
    --
    -- Case is not normalised: only the exact spelling can ever sign in, so only
    -- the exact spelling is worth bounding. Length is capped at 254 by the
    -- route (RFC 5321) rather than by this column, so an over-long address is
    -- refused with the one sentence every other failure gets instead of being
    -- refused by the driver with a 500.
    "email" TEXT NOT NULL,

    -- Where it came from, as the Next server reported it. Null where nothing
    -- did: the API binds 127.0.0.1 and every request it sees is made by that
    -- server, so this is a fact it cannot learn for itself.
    "source" TEXT,

    -- From the injected TimeSource and never a database default (ADR-0022).
    -- The limit is counted against the same clock, so a test ages the window by
    -- advancing a fake rather than by sleeping.
    "attempted_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sign_in_failures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
--
-- The two counts the throttle makes in the trailing window, and the only reads
-- this table has. Composite and in this order because both are a scope plus a
-- range over the stamp, which is the shape every other index in this schema has
-- (`@@index([project_id, arrived_at])`, `@@index([user_id, created_at])`).
--
-- The first carries "source" because the count does. An address's ten are spent
-- **per source**: counting the address alone would let somebody who knew an
-- engineer's address spend its ten and hold that engineer out of a walk for as
-- long as they cared to, which is the one outcome ADR-0062 says nothing here
-- may reach. What it gives up is bounding a distributed guess at one account,
-- and that is a gap the same record already names.
CREATE INDEX "sign_in_failures_email_source_attempted_at_idx" ON "sign_in_failures"("email", "source", "attempted_at");

CREATE INDEX "sign_in_failures_source_attempted_at_idx" ON "sign_in_failures"("source", "attempted_at");
