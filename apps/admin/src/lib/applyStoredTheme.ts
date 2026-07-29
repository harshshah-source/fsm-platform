/**
 * Sets `data-theme` on `<html>` from the persisted preference (falling back to the OS) *before* React
 * mounts. Without this, a dark-mode reload paints the light canvas for a frame — `ThemeProvider`'s
 * effect only runs after the first commit. Kept deliberately tiny and dependency-free so it can run
 * as the very first thing in `main.tsx`.
 *
 * Must stay in sync with `THEME_STORAGE_KEY` in `components/shell/ThemeContext.tsx`, which owns the
 * attribute from mount onwards.
 */
export function applyStoredTheme(): void {
  try {
    const stored = globalThis.localStorage?.getItem('fsm.admin.theme');
    const theme =
      stored === 'light' || stored === 'dark'
        ? stored
        : globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
    globalThis.document?.documentElement.setAttribute('data-theme', theme);
  } catch {
    // Blocked storage / no matchMedia — leave the attribute unset, which is light.
  }
}
