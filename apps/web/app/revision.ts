/**
 * A submission's revision as a label (issue #173).
 *
 * The column is the engineer's free text: the form suggests `Rev 1`, and a
 * record may hold a bare `0`. A bare value reads as a stray number on its own —
 * the submission screen's title was `0` — so it gains the word, and a value
 * that already says it is left as typed.
 */
export function revisionLabel(revision: string): string {
  return /^rev/i.test(revision.trim()) ? revision : `Rev ${revision}`;
}
