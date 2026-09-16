/**
 * What a photograph evidences, as one native select's value (issue #113,
 * ADR-0056).
 *
 * **One control for one fact.** A photograph holds at most one of an
 * observation and a finding, so two independent selects would present as
 * independent a pair the record refuses to let disagree — ADR-0030's reason
 * for making Side and Sector one control on the observation form, arriving for
 * a second record. Picking in it is one action either way, which is what the
 * ADR asks of moving a photograph between the two.
 *
 * The encoding lives in a module of its own because the control in a client
 * component and the server action reading `FormData` are the two halves of one
 * format: a `'use server'` module cannot import a function out of a
 * `'use client'` one, so writing it in either would mean writing it twice, and
 * a format with two spellings is what this codebase refuses everywhere else.
 *
 * (Named without the angle brackets on purpose — `native-selects.test.tsx`
 * sweeps the source for the element and would read the prose as a control.)
 */

const OBSERVATION = 'observation:';
const ISSUE = 'issue:';

/** The empty option: a photograph that evidences nothing is unfiled. */
export const EVIDENCES_NOTHING = '';

/**
 * One binding as the control spells it — the value an option carries, and the
 * value the control starts on, from the one function so they cannot drift.
 */
export function evidenceValue(binding: {
  observationId: string | null;
  issueNumber: number | null;
}): string {
  if (binding.observationId !== null) {
    return `${OBSERVATION}${binding.observationId}`;
  }
  return binding.issueNumber === null
    ? EVIDENCES_NOTHING
    : `${ISSUE}${binding.issueNumber}`;
}

/** What was chosen, read back off the form. */
export type ChosenEvidence =
  | { observationId: string }
  | { issueNumber: number | null };

/**
 * The value the form sent, as the binding it names.
 *
 * An unrecognised value reads as *nothing*, which clears the binding rather
 * than sending a body the API would refuse: the options are this module's and
 * anything else arrived from somewhere that is not the screen.
 */
export function chosenEvidence(value: string): ChosenEvidence {
  if (value.startsWith(OBSERVATION)) {
    return { observationId: value.slice(OBSERVATION.length) };
  }
  if (value.startsWith(ISSUE)) {
    const number = Number(value.slice(ISSUE.length));
    return { issueNumber: Number.isSafeInteger(number) ? number : null };
  }
  return { issueNumber: null };
}
