import { IconMoon, IconSun } from '../ui/icons';
import { useTheme } from './ThemeContext';

/**
 * Top-bar light/dark switch. A two-position track rather than a bare icon button: the operator can
 * see which mode is active without having to decode whether the icon shows the current state or the
 * one it would switch to (the classic ambiguity of a single-icon toggle).
 *
 * The knob slides; the two icons stay put and just change weight. `role="switch"` + `aria-checked`
 * (checked = dark) gives assistive tech the state directly.
 */
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      onClick={toggle}
      role="switch"
      aria-checked={isDark}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className="relative flex h-10 w-[3.75rem] shrink-0 items-center rounded-full border border-line bg-surface-raised px-1 transition-colors hover:border-line-strong focus-ring"
    >
      {/* Sliding knob — sits under the icons so the active one reads on top of it. */}
      <span
        aria-hidden
        className={`absolute left-1 top-1 h-7 w-7 rounded-full bg-surface-card shadow-card transition-transform duration-200 ease-out ${
          isDark ? 'translate-x-[1.75rem]' : 'translate-x-0'
        }`}
      />
      <span
        aria-hidden
        className={`relative z-10 flex h-7 w-7 items-center justify-center transition-colors ${
          isDark ? 'text-ink-muted' : 'text-warning'
        }`}
      >
        <IconSun className="h-4 w-4" />
      </span>
      <span
        aria-hidden
        className={`relative z-10 ml-auto flex h-7 w-7 items-center justify-center transition-colors ${
          isDark ? 'text-info' : 'text-ink-muted'
        }`}
      >
        <IconMoon className="h-4 w-4" />
      </span>
    </button>
  );
}
