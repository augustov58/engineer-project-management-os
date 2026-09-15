import type { AuditEntry } from './api';

/**
 * Where an audit line's subject is on this site, or nowhere (issue #111).
 *
 * The line says which row changed; this says whether there is a screen keyed
 * by that row's id to go to. **The map is deliberately partial**, and the
 * partiality is on this side rather than on the record's:
 *
 * - A **finding**'s URL carries its `number` and not its id (ADR-0031: the
 *   identifier is the thing anybody has written down), and the line carries
 *   the row's id, because that is the row it touched. Putting the number in
 *   `subject_id` to suit this map would put a value in the record chosen for
 *   a screen's convenience, which is the wrong way round.
 * - A **photograph**, an **observation**, a **document**, an **open item** and
 *   the rest have no page of their own at all; they are read through the walk,
 *   the job or the set they belong to.
 *
 * A subject with nowhere to go renders as plain text, which says the same
 * thing the record does: this happened to that row, and there is no screen for
 * it yet. Adding one is what extends this map — it is not a reason to change
 * what the audit stores.
 */
export function subjectHref(entry: AuditEntry): string | null {
  const { subject, projectId } = entry;
  if (subject === null) {
    return null;
  }
  switch (subject.type) {
    case 'project':
      return `/projects/${subject.id}`;
    case 'submission':
      return `/submissions/${subject.id}`;
    case 'site-visit':
      return `/site-visits/${subject.id}`;
    case 'register-entry':
      return `/register-entries/${subject.id}`;
    case 'extraction':
      return `/projects/${projectId}/extractions/${subject.id}`;
    // One screen for the whole record, since a project has exactly one memory
    // and no identity table beneath it (ADR-0040): a version, a proposal and
    // the run that wrote it are all read there.
    case 'memory-version':
    case 'memory-proposal':
    case 'agent-run':
      return `/projects/${projectId}/memory`;
    case 'user':
      return '/users';
    default:
      return null;
  }
}
