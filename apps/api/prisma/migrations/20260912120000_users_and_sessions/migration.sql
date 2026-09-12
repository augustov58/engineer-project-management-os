-- Users and sessions replace the shared secret at the edge (issue #105,
-- ADR-0055, superseding ADR-0012 and ADR-0020).
--
-- ADR-0012 said "a personal tool … multi-user is a real future migration, not
-- a config change." The first half was reversed on 2026-09-08, when the
-- author's answer became other engineers at the firm; the second half was
-- honest, and this is that migration.
--
-- **No `roles`, no `permissions`, no `tenants`.** One firm per deployment,
-- everyone sees everything, and what a person did is recorded rather than
-- prevented. `test/schema.test.ts` asserts all three absences here exactly as
-- it asserted `users`' absence for twenty-one slices.
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "disabled_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- One signed-in browser, or one agent run.
--
-- The difference from the secret it replaces is this table: a shared secret
-- had no state, so rotating it was a redeploy and there was nothing to revoke,
-- while a session is a row and `revoked_at` takes one out on its own
-- (ADR-0055). `id` carries no default: it is a credential minted at the API
-- boundary from 32 random bytes, and a `gen_random_uuid()` here would be a
-- second place one could come from — the shape ADR-0022 gives every timestamp.
--
-- `agent_run_id` is null for every row a person's sign-in writes. A run acts
-- under the person who started it and is never an actor itself, so the row
-- still names a user; the column is what lets a later slice say a line was
-- written during a run (ADR-0055 part 6, issue #111).
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "agent_run_id" TEXT,
    "extraction_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id"),
    -- A session belongs to at most one run. This product has two run records
    -- and not one — ADR-0043 made an extraction a record of its own rather
    -- than an `agent_runs` row — so the link ADR-0055 names has a second
    -- spelling, and the CHECK is what stops a row claiming both. Both null is
    -- a person signing in, which is every other row.
    CONSTRAINT "sessions_one_run" CHECK (num_nonnulls("agent_run_id", "extraction_id") <= 1)
);

CREATE INDEX "sessions_user_id_created_at_idx" ON "sessions"("user_id", "created_at");

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_agent_run_id_fkey" FOREIGN KEY ("agent_run_id") REFERENCES "agent_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_extraction_id_fkey" FOREIGN KEY ("extraction_id") REFERENCES "register_entry_extractions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An audit line's job becomes optional (issue #105).
--
-- Every line written until now was about a row on a project, and the column
-- was required because there was nothing else to write one about. There is
-- now: creating a user and signing in are the **firm's** mutations, not a
-- job's. Inventing a project for them would put a line on a screen it is not
-- about, and leaving them unwritten would put a hole in the sweep that
-- `test/audit.test.ts` runs over every mutating route.
--
-- Nothing is backfilled and nothing moves: every existing line keeps its
-- project. Both readers of this table — `GET /projects/:id/memory/audit` and
-- the activity feed — already filter on this column, so a firm-level line is
-- absent from a project's audit rather than mislabelled in it. The foreign
-- key's ON DELETE stays RESTRICT, spelled in the schema now that the relation
-- is optional and Prisma would otherwise default it to SET NULL
-- (20260901023535_restore_restrict_on_delete is why that matters).
ALTER TABLE "audit_entries" ALTER COLUMN "project_id" DROP NOT NULL;
