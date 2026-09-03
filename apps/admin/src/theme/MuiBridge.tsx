import { ThemeProvider as MuiThemeProvider } from '@mui/material/styles';
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useTheme } from '../components/shell/ThemeContext';
import { buildMuiTheme } from './muiTheme';

/**
 * Hands the app's resolved light/dark theme to MUI. Mounts inside the app's own `ThemeProvider`
 * (which owns `data-theme` on `<html>`), so the two never disagree about which mode is painted.
 *
 * Deliberately no `CssBaseline`: `index.css` already owns the document baseline, and MUI's would
 * overwrite the body gradient and the token-driven canvas.
 *
 * A page rendered outside this bridge — every unit test does exactly that — still renders; MUI just
 * falls back to its stock theme. Nothing here may become load-bearing for correctness.
 */
export function MuiBridge({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  const muiTheme = useMemo(() => buildMuiTheme(theme), [theme]);

  return <MuiThemeProvider theme={muiTheme}>{children}</MuiThemeProvider>;
}
