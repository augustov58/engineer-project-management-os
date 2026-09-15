/**
 * The append-only audit record, the one way a line of it is written
 * (story 106), and the one shape both readers hand one back in (issue #111).
 *
 * A **leaf** in ADR-0033's sense: it imports Prisma's types and nothing from a
 * route module, so every record can reach it without reaching through another
 * record. It became one the moment a second record wrote a line — the trigger
 * ADR-0033 names, and the trigger `stream.ts` was extracted on.
 *
 * The scope was memory alone until now. ADR-0040 wrote the rule and said
 * widening it to every record's mutations was "its own change, not something
 * to do row by row"; ADR-0044 widened it once, for the processing location,
 * and said the same. This is that change, taken in one pass over every
 * mutating route rather than a record at a time.
 *
 * Two properties are kept and neither is negotiable:
 *
 * - **The line is written in the same transaction as the mutation it
 *   describes**, so no path exists on which the record moved and the log does
 *   not say so (ADR-0040). That is why the parameter is a
 *   `Prisma.TransactionClient` and never the bare client: a route with nothing
 *   to open a transaction for has to open one to say what it did.
 * - **`at` is supplied** and is the caller's `timeSource.now()`, never read
 *   here and never a database default (ADR-0022). A route that stamps its own
 *   row and its audit line from one instant is a route whose record and whose
 *   log agree about when, down to the millisecond.
 *
 * Nothing updates or deletes a line: there is no route that touches this table
 * but the writers, which is what append-only means here — by construction,
 * rather than by a guard.
 */

import type { Prisma } from '../generated/prisma/client.js';

/**
 * Which kind of record a line is about, and the whole of the closed set.
 *
 * A union in TypeScript and a plain text column underneath, which is
 * `action`'s shape and deliberately not ADR-0031's text-with-a-CHECK. That
 * rule exists for a value an engineer picks off a list at the boundary, where
 * a database constraint is the floor under a body schema; this one is spelled
 * at the call site and no request can supply it, so `tsc` checks every writer
 * there is and a CHECK would only add a migration to every new record type.
 *
 * Spelled the way a URL is rather than the way a table is: these are what a
 * screen follows back to the row that changed, and `open-item` reads as the
 * glossary's **Open item** where `open_items` reads as storage.
 *
 * Two absences are deliberate. A **register** is written in the transaction
 * that writes the project and no route touches one (ADR-0036), so nothing
 * would ever name it. A **counterfactual** is keyed by the record and the
 * line it is about and has no id of its own (ADR-0029), so the line naming
 * one names the assumption record — a join's rule, and the only other row
 * here with no identity.
 */
export type SubjectType =
  | 'project'
  | 'phase'
  | 'submission'
  | 'open-item'
  | 'assumption-record'
  | 'site-visit'
  | 'site-visit-floor'
  | 'observation'
  | 'issue'
  | 'photo'
  | 'voice-capture'
  | 'site-visit-report'
  | 'register-entry'
  | 'document'
  | 'document-version'
  | 'ingested-document'
  | 'extraction'
  | 'memory-version'
  | 'memory-proposal'
  | 'agent-run'
  | 'user';

/**
 * The row the mutation touched.
 *
 * The record the line is *about*: the row created, or the row changed. Where a
 * mutation writes only a join — a document linked to a submission, an open
 * item attached to an issue — the subject is the record the link was added to,
 * a join row having no identity of its own to point at.
 *
 * **Never a `sessions` row.** A session id is the credential itself, and this
 * table is append-only, exported whole and read on a screen. Signing in and
 * signing out name the **user** instead, which is the record a reader wants
 * anyway.
 */
export interface Subject {
  type: SubjectType;
  id: string;
}

/**
 * Who made the mutation, and the run they made it during (ADR-0055 parts 4
 * and 6).
 *
 * Read from the session the gate validated and **never from a request body**:
 * a caller who could name the actor could name somebody else. `actorOf` in
 * `gate.ts` is the one way one of these is built from a request.
 *
 * An agent is never an actor. A run holds a session in the name of the person
 * who started it, so `userId` is that person and one of the two run ids says
 * which run — at most one, by a CHECK, because this product has two run
 * records (ADR-0043) and `sessions` already answers the same question with two
 * columns.
 */
export interface Actor {
  userId: string | null;
  agentRunId: string | null;
  extractionId: string | null;
}

/**
 * Nobody presented a session, which is **one route and three commands**.
 *
 * `POST /v1/ingest/inbound-mail` is the one route the gate lets through
 * (ADR-0042), and its line saying so is what ADR-0055 means by "the one place
 * a **request** has no actor". The other three are not requests at all:
 * `user create`, `user reset` and `user enable` run on the machine, which is
 * the floor under a deployment nobody can sign in to — and the first account
 * has, by definition, nobody to be recorded against.
 *
 * `user create` is the one of the four that is not always actorless: the same
 * `createUser` serves `POST /v1/users`, where a signed-in engineer adds the
 * next account, so the actor is a parameter there rather than a constant.
 *
 * A named constant rather than three nulls spelled out, so that an actorless
 * line reads as a decision at the call site and `grep` finds every one of
 * them — which is what `test/audit.test.ts` does, asserting the exact four.
 */
export const NO_ACTOR: Actor = {
  userId: null,
  agentRunId: null,
  extractionId: null,
};

/** One line of the record: whose job, what happened, and the particulars. */
export interface AuditLine {
  /**
   * Whose job, where the mutation was on one, and **null where it was not**
   * (issue #105). Creating a user and signing in are the firm's mutations and
   * not a job's; inventing a project for them would put a line on a screen it
   * is not about, and writing no line would put a hole in the sweep
   * `test/audit.test.ts` runs over every mutating route. Both readers of this
   * table filter on the column, so a firm-level line is absent from a
   * project's audit rather than mislabelled in it.
   */
  projectId: string | null;
  /**
   * Who, and the run they were acting during (issue #111).
   *
   * **Required**, which is what makes "every line says who" a fact `tsc`
   * holds rather than a habit. A line nobody presented a session for says so
   * with `NO_ACTOR` and is a decision at the call site, not an omission.
   */
  actor: Actor;
  /**
   * Which row the mutation touched. Required, for the same reason: `detail`
   * is prose and names nothing a screen can follow.
   */
  subject: Subject;
  /**
   * What happened — "submission recorded", "issue closed". Text and not an
   * enum, and phrased as a sentence for a reader: the set is closed by what
   * the writers write rather than by the database.
   */
  action: string;
  /**
   * The particulars. Free text; the structured fact it describes is on the row
   * it is about, and a reader comes here for the narrative. Where a mutation
   * empties a column, this is the only place its old value survives — the
   * reason ADR-0044's processing-location line carries the sign-off it cleared.
   */
  detail: string;
  /** The caller's instant, from the injected `TimeSource`. */
  at: Date;
}

/** Write one line, inside the caller's transaction. */
export async function audit(
  tx: Prisma.TransactionClient,
  { projectId, actor, subject, action, detail, at }: AuditLine,
): Promise<void> {
  await tx.auditEntry.create({
    data: {
      projectId,
      actorId: actor.userId,
      agentRunId: actor.agentRunId,
      extractionId: actor.extractionId,
      subjectType: subject.type,
      subjectId: subject.id,
      action,
      detail,
      createdAt: at,
    },
  });
}

/**
 * What the two readers of this table need loaded, so that a line can say
 * **who** and not just which uuid.
 *
 * `GET /v1/projects/:id/memory/audit` and `GET /v1/projects/:id/activity` read
 * the same rows in opposite orders (ADR-0048), and they return the same shape
 * for the same reason they read the same store: a feed-specific rendering is a
 * second version of one fact, free to fall behind. One include and one mapper,
 * here beside the writer, is what keeps the two from drifting.
 */
export const auditEntryInclude = {
  actor: { select: { id: true, name: true } },
} satisfies Prisma.AuditEntryInclude;

type AuditEntryRow = Prisma.AuditEntryGetPayload<{
  include: typeof auditEntryInclude;
}>;

/** The run a line was written during, where it was written during one. */
export interface RunReference {
  type: 'agent-run' | 'extraction';
  id: string;
}

/** One line, as both readers return it. */
export interface AuditEntryOnTheWire {
  id: string;
  projectId: string | null;
  /**
   * Who, by **name** and not only by id: "who recorded this" is a question
   * somebody asks of a screen. Null on the three lines nobody presented a
   * session for, and on every line written before issue #111 on a deployment
   * that had no accounts to backfill to.
   */
  actor: { id: string; name: string } | null;
  /** The run, never the session it held: a session id is a credential. */
  run: RunReference | null;
  /** Null on the lines that predate the column, and on nothing written since. */
  subject: Subject | null;
  action: string;
  detail: string;
  createdAt: Date;
}

export function auditEntryOnTheWire(row: AuditEntryRow): AuditEntryOnTheWire {
  return {
    id: row.id,
    projectId: row.projectId,
    actor: row.actor,
    run:
      row.agentRunId !== null
        ? { type: 'agent-run', id: row.agentRunId }
        : row.extractionId !== null
          ? { type: 'extraction', id: row.extractionId }
          : null,
    // The column is `text` and the closed set lives in TypeScript, so reading
    // one back is the one place the two have to be reconciled. Nothing outside
    // this repository can write the column — every writer goes through
    // `audit()` above, where `SubjectType` is checked — so the assertion is
    // about a value this codebase spelled, not about a value a caller sent.
    subject:
      row.subjectType !== null && row.subjectId !== null
        ? { type: row.subjectType as SubjectType, id: row.subjectId }
        : null,
    action: row.action,
    detail: row.detail,
    createdAt: row.createdAt,
  };
}
