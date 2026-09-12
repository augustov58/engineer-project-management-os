/**
 * The append-only audit record, and the one way a line of it is written
 * (story 106).
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
  { projectId, action, detail, at }: AuditLine,
): Promise<void> {
  await tx.auditEntry.create({
    data: { projectId, action, detail, createdAt: at },
  });
}
