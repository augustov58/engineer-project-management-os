import { cn } from '@/lib/utils';
import type { Theme } from './api';
import { setTheme } from './theme-actions';

/**
 * The theme control: System, Light, Dark (issue #117, the design brief's
 * decision 2).
 *
 * **Three submit buttons and not a dropdown.** Every other closed vocabulary a
 * person picks from in this product is the native select element (ADR-0025),
 * and those are all fields inside a form that serialises something else too.
 * This one is the whole form: a dropdown would need a second tap on a submit
 * button, or JavaScript to submit on change, and the brief asks for one
 * action. Each button carries its own value, so the form posts and the server
 * re-renders with the class already written — which is why there is no client
 * component here and no flash of the other theme.
 */
const THEMES: { value: Theme; label: string }[] = [
  { value: 'SYSTEM', label: 'System' },
  { value: 'LIGHT', label: 'Light' },
  { value: 'DARK', label: 'Dark' },
];

export function ThemeForm({ theme }: { theme: Theme }) {
  return (
    <form action={setTheme} className="flex items-center">
      <fieldset className="flex items-center gap-1">
        <legend className="sr-only">Theme</legend>
        {THEMES.map(({ value, label }) => (
          <button
            key={value}
            type="submit"
            name="theme"
            value={value}
            aria-pressed={value === theme}
            className={cn(
              'rounded-md px-2 py-1 text-xs transition-colors',
              value === theme
                ? 'bg-secondary text-secondary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </fieldset>
    </form>
  );
}
