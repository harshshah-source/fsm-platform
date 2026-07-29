import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Light/dark theme state for the whole admin shell.
 *
 * The theme is expressed as one attribute — `data-theme` on `<html>` — which re-points the design
 * tokens in `index.css`. No component subscribes to this context for styling; they keep using the
 * same `bg-surface-card` / `text-ink` utilities and follow along automatically. Only the toggle in
 * the top bar reads it.
 *
 * Three-state on purpose: `'system'` is the default and keeps tracking the OS as it changes (an
 * operator on a scheduled night-shift theme shouldn't have to flip it by hand), while an explicit
 * `'light'`/`'dark'` pins it and is persisted.
 */
const STORAGE_KEY = 'fsm.admin.theme';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

function readPersistedPreference(): ThemePreference {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : 'system';
  } catch {
    // Private-mode / blocked storage — fall back to following the OS.
    return 'system';
  }
}

function prefersDark(): boolean {
  // jsdom has no matchMedia; the optional call keeps the provider mountable in tests.
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

interface ThemeState {
  /** What the user chose — `'system'` until they touch the toggle. */
  preference: ThemePreference;
  /** What is actually painted right now (`'system'` already resolved against the OS). */
  theme: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
  /** Flip to the opposite of what is currently painted, pinning the choice. */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPersistedPreference);
  const [systemDark, setSystemDark] = useState<boolean>(prefersDark);

  // Track the OS preference for as long as we are on `'system'`. The listener is always attached
  // (it is cheap) so switching back to `'system'` picks up the current value with no extra wiring.
  useEffect(() => {
    const mql = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mql) return;
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  const theme: ResolvedTheme = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;

  // The single write that makes the theme real. `main.tsx` sets the same attribute before React
  // mounts so there is no light flash on a dark-mode reload; this keeps it in sync afterwards.
  useEffect(() => {
    globalThis.document?.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    try {
      if (preference === 'system') {
        globalThis.localStorage?.removeItem(STORAGE_KEY);
      } else {
        globalThis.localStorage?.setItem(STORAGE_KEY, preference);
      }
    } catch {
      // Persistence is best-effort; ignore storage failures.
    }
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => setPreferenceState(next), []);
  const toggle = useCallback(
    () => setPreferenceState(preference === 'system' ? (systemDark ? 'light' : 'dark') : preference === 'dark' ? 'light' : 'dark'),
    [preference, systemDark],
  );

  const value = useMemo<ThemeState>(
    () => ({ preference, theme, setPreference, toggle }),
    [preference, theme, setPreference, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a <ThemeProvider>');
  }
  return ctx;
}

// eslint-disable-next-line react-refresh/only-export-components
export { STORAGE_KEY as THEME_STORAGE_KEY };
