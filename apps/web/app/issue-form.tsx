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
 * Pick one thing and do one thing: the shape both controls under an
 * observation have.
 *
 * One component rather than two nearly identical ones, for the reason
 * `NewOpenItemForm` is shared between the project and submission screens —
 * they sit side by side on the same row, so a change to one that missed the
 * other would be visible immediately.
 */
function ChooseAndSubmit({
  submit,
  name,
  label,
  placeholder,
  options,
  action,
  variant,
}: {
  submit: (previous: AddState, formData: FormData) => Promise<AddState>;
  name: string;
  label: string;
  placeholder: string;
  options: { value: string; text: string }[];
  action: string;
  variant: 'secondary' | 'ghost';
}) {
  const [state, formAction, pending] = useActionState(submit, { added: 0 });

  return (
    <div className="space-y-1">
      <form
        key={state.added}
        action={formAction}
        className="flex flex-wrap gap-2"
      >
        {/* Native, because the action reads this out of FormData (ADR-0025). */}
        <select
          name={name}
          required
          aria-label={label}
          defaultValue=""
          className={`${selectClassName} min-w-48 flex-1`}
        >
          <option value="" disabled>
            {placeholder}
          </option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.text}
            </option>
          ))}
        </select>
        <Button type="submit" variant={variant} size="sm" disabled={pending}>
          {action}
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
  return (
    <ChooseAndSubmit
      submit={submit}
      name="category"
      label="Category of this finding"
      placeholder="Category…"
      options={CATEGORIES.map((category) => ({
        value: category,
        text: category,
      }))}
      action="Record as an issue"
      variant="secondary"
    />
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
  return (
    <ChooseAndSubmit
      submit={submit}
      name="issueId"
      label="The issue this is another sighting of"
      placeholder="…or another sighting of"
      options={issues.map((issue) => ({
        value: issue.id,
        text: `Issue ${issue.number} — ${issue.category}`,
      }))}
      action="Re-observe"
      variant="ghost"
    />
  );
}
