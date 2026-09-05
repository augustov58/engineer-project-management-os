import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { RaiseIssueForm } from '../app/issue-form';
import { occurrences, productSources } from './sources';

/**
 * Every select in this product is the native element (ADR-0025).
 *
 * Not a style preference. Every one of them sits inside a form whose action
 * reads the value straight out of `FormData`, and a styled component changes
 * how the control serialises — which is a defect that renders correctly, so
 * nobody reviewing a screenshot would see it and `tsc` has nothing to say
 * about it either.
 *
 * Two tests, because the substitution and the wiring are different failures:
 * the scan below catches a `<select>` that stopped being the shared native
 * one, and the render catches a form that stopped carrying its value.
 */

afterEach(cleanup);

/** `app/native-select.ts` is where the styling is defined, not used. */
const definition = 'app/native-select.ts';

test('every select carries the shared native styling', () => {
  const wrong: string[] = [];

  for (const source of productSources()) {
    if (source.path === definition) {
      continue;
    }
    const selects = occurrences(source.text, /<select[\s>]/);
    if (selects === 0) {
      continue;
    }
    // One mention is the import; the rest are the `className`s. A `<select>`
    // that grew without one is a control styled by hand, and the next one
    // after it is a shadcn component nobody argued for.
    const styled = occurrences(source.text, /selectClassName/) - 1;
    if (styled !== selects) {
      wrong.push(`${source.path}: ${selects} selects, ${styled} styled`);
    }
  }

  expect(wrong).toEqual([]);
});

test('nothing imports the Radix select', () => {
  // `components/ui/select.tsx` is shadcn scaffolding this product has never
  // used. It renders a button and a portal, and a form around it serialises
  // whatever Radix decides to leave in the DOM rather than what the engineer
  // picked. If it is ever imported, that is the decision ADR-0025 took being
  // reversed by an autocomplete.
  const importers = productSources()
    .filter((source) => /from '[^']*components\/ui\/select'/.test(source.text))
    .map((source) => source.path);

  expect(importers).toEqual([]);
});

test('a native select serialises into the FormData the action reads', async () => {
  const submitted = vi.fn();
  const action = async (_previous: { added: number }, formData: FormData) => {
    submitted(formData.get('category'));
    return { added: 1 };
  };

  render(<RaiseIssueForm submit={action} />);

  const control = screen.getByLabelText('Category of this finding');
  // The control itself, before anything is typed into it: a `SELECT` and not
  // a `BUTTON` with a listbox behind it.
  expect(control.tagName).toBe('SELECT');

  fireEvent.change(control, { target: { value: 'Functional' } });
  fireEvent.submit(control.closest('form') as HTMLFormElement);

  await waitFor(() => expect(submitted).toHaveBeenCalledWith('Functional'));
});
