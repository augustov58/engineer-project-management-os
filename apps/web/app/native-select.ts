/**
 * A native `<select>`, styled to match the shadcn `Input`.
 *
 * Deliberately not the Radix Select. Every select in this product sits inside
 * a form whose action reads the value straight out of `FormData`, and
 * ADR-0025 keeps the native element wherever a styled component would change
 * how a control serialises.
 */
export const selectClassName =
  'h-8 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';
