import { createTheme, type Theme } from '@mui/material/styles';
import type { ResolvedTheme } from '../components/shell/ThemeContext';

/**
 * MUI theme bridged onto the FSM design tokens.
 *
 * The app's own styling is Tailwind v4 + Radix, and dark mode is nothing but a `data-theme` swap of
 * the `--color-*` variables in `index.css` — no component carries a raw hex. MUI cannot join that
 * scheme directly: its palette values are fed through colour maths (`alpha()`, `lighten()`,
 * `darken()`, ripple and hover overlays), and those functions parse the string they are given. A
 * `var(--color-brand-600)` reaches them unresolved and throws, so a MUI surface left unbridged
 * renders default light Material on the pitch-black canvas.
 *
 * So the palette is declared as LITERALS, mirrored per mode from the two token blocks in
 * `index.css` — the same trade-off `components/charts/colors.ts` already documents for recharts
 * series colours. Anything MUI hands straight to CSS without maths (dividers, backgrounds set via
 * `styleOverrides`) still goes through `var(--color-*)` so it tracks the tokens for free.
 *
 * KEEP IN SYNC with `index.css`: the `@theme` block feeds `light`, `:root[data-theme="dark"]` feeds
 * `dark`. Only the tokens MUI actually needs are mirrored here, not the whole scale.
 */
const PALETTE = {
  light: {
    brand: '#b9102b',
    brandDark: '#8f0f24',
    ink: '#32343a',
    inkStrong: '#101114',
    inkMuted: '#6b6e76',
    card: '#ffffff',
    app: '#f2f3f5',
    sunken: '#ebedf0',
    line: '#e4e6ea',
    info: '#1d4ed8',
    success: '#197a3d',
    warning: '#9a6700',
    critical: '#b42318',
  },
  dark: {
    brand: '#d81f3c',
    brandDark: '#a5122a',
    ink: '#e6e6e6',
    inkStrong: '#ffffff',
    inkMuted: '#ababab',
    card: '#0d0d0d',
    app: '#000000',
    sunken: '#1f1f1f',
    line: '#262626',
    info: '#5b8dff',
    success: '#35b46a',
    warning: '#d99a2b',
    critical: '#e5484d',
  },
} as const;

/**
 * Build the MUI theme for a resolved (already OS-collapsed) theme. Memoised by the caller on
 * `theme`, so this runs twice per session at most.
 */
export function buildMuiTheme(mode: ResolvedTheme): Theme {
  const c = PALETTE[mode];

  return createTheme({
    palette: {
      mode,
      primary: { main: c.brand, dark: c.brandDark, contrastText: '#ffffff' },
      info: { main: c.info },
      success: { main: c.success },
      warning: { main: c.warning },
      error: { main: c.critical },
      divider: c.line,
      background: { default: c.app, paper: c.card },
      text: { primary: c.inkStrong, secondary: c.inkMuted },
    },

    // Match the Tailwind type scale rather than Material's, so a MUI control set next to a native
    // one does not shift the baseline. `Inter` first, mirroring `--font-sans`.
    typography: {
      fontFamily:
        'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      button: { textTransform: 'none', fontWeight: 600, fontSize: 11 },
    },

    shape: { borderRadius: 8 },

    components: {
      // The app renders its own baseline in `index.css`; MUI's CssBaseline would fight it, so it is
      // never mounted. These overrides therefore have to paint their own surfaces.
      MuiToggleButtonGroup: {
        styleOverrides: {
          root: {
            backgroundColor: 'var(--color-surface-card)',
            border: '1px solid var(--color-line)',
            borderRadius: 9999,
            padding: 3,
            gap: 2,
          },
          grouped: {
            border: 0,
            borderRadius: '9999px !important',
          },
        },
      },
      MuiToggleButton: {
        styleOverrides: {
          root: {
            border: 0,
            borderRadius: 9999,
            padding: '4px 10px',
            lineHeight: 1.4,
            color: 'var(--color-ink-muted)',
            letterSpacing: 0,
            '&:hover': {
              backgroundColor: 'var(--color-surface-sunken)',
              color: 'var(--color-ink-strong)',
            },
            '&.Mui-selected': {
              backgroundColor: c.brand,
              color: '#ffffff',
              '&:hover': { backgroundColor: c.brandDark, color: '#ffffff' },
            },
          },
        },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            backgroundColor: 'var(--color-chrome-900)',
            color: '#ffffff',
            fontSize: 11,
            fontWeight: 500,
            padding: '6px 10px',
            borderRadius: 8,
          },
          arrow: { color: 'var(--color-chrome-900)' },
        },
      },
    },
  });
}
