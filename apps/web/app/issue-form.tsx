'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { selectClassName } from './native-select';
import type { AddState } from './actions';
import type { Issue } from './api';

/**
 * The closed set of exactly five, in the words the glossary writes them.
 *
 * A second copy of the API's list, the way every response interface in
 * `api.ts` is a second copy of the harness's — the two apps share no package.
 * They cannot drift silently: the API refuses a category it does not know, and
 * a sixth typed here would come straight back as a refusal on this form.
 */
const CATEGORIES = [
  'Accessibility',
  'Physical / Safety',
  'Functional',
  'Safety / Code',
  'Design / Coordination',
];

/**
 * Recording an observation as a finding.
 *
 * The category is the only field: what was seen, when and where is already the
 * observation's, and the identifier is allocated by the API — a form that
 * could name its own number could reuse one.
 *
 * Nothing here is the default path. Most observations stay observations, which
 * is why this is a small control under one of them rather than a step in
 * recording it.
 */
export function RaiseIssueForm({
  submit,
}: {
  submit: (previous: AddState, formData: FormData) => Promise<AddState>;
}) {
  const [state, action, pending] = useActionState(submit, { added: 0 });

  return (
    <div className="space-y-1">
      <form key={state.added} action={action} className="flex flex-wrap gap-2">
        {/* Native, because the action reads this out of FormData (ADR-0025). */}
        <select
          name="category"
          required
          aria-label="Category of this finding"
          defaultValue=""
          className={`${selectClassName} min-w-48 flex-1`}
        >
          <option value="" disabled>
            Category&hellip;
          </option>
          {CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {category}
            </option>
          ))}
        </select>
        <Button type="submit" variant="secondary" size="sm" disabled={pending}>
          Record as an issue
        </Button>
      </form>
      {state.error !== undefined && (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      )}
    </div>
  );
}

/**
 * Still there on the second walk: this sighting joins a finding already on the
 * register rather than raising a second one under a new identifier.
 *
 * Offered only where the job already has issues, because on a first walk there
 * is nothing to re-observe and an empty select would be a control that cannot
 * be used.
 */
export function ReobserveForm({
  submit,
  issues,
}: {
  submit: (previous: AddState, formData: FormData) => Promise<AddState>;
  issues: Issue[];
}) {
  const [state, action, pending] = useActionState(submit, { added: 0 });

  return (
    <div className="space-y-1">
      <form key={state.added} action={action} className="flex flex-wrap gap-2">
        <select
          name="issueId"
          required
          aria-label="The issue this is another sighting of"
          defaultValue=""
          className={`${selectClassName} min-w-48 flex-1`}
        >
          <option value="" disabled>
            &hellip;or another sighting of
          </option>
          {issues.map((issue) => (
            <option key={issue.id} value={issue.id}>
              Issue {issue.number} &mdash; {issue.category}
            </option>
          ))}
        </select>
        <Button type="submit" variant="ghost" size="sm" disabled={pending}>
          Re-observe
        </Button>
      </form>
      {state.error !== undefined && (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      )}
    </div>
  );
}
