/**
 * A native `<select>`, styled to match the shadcn `Input`.
 *
 * Deliberately not the Radix Select. Every select in this product sits inside
 * a form whose action reads the value straight out of `FormData`, and
 * ADR-0025 keeps the native element wherever a styled component would change
 * how a control serialises.
 */
const shared =
  'rounded-lg border border-input bg-card px-2.5 py-1 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';

/** The desk height: the design brief's density rule 6 asks for ≥ 32 px there. */
export const selectClassName = `h-8 ${shared}`;

/**
 * The same control at a **field** target (issue #118, density rule 6): ≥ 44 px
 * on the screens used one-handed on a walk.
 *
 * A second constant rather than a taller shared one, because the rule is two
 * numbers and not one — the desk keeps 32 px, and this ticket is the field.
 * The photograph-binning select is the control bar 3 actually measures, and it
 * was 32 px at the baseline.
 */
export const fieldSelectClassName = `h-11 ${shared}`;
