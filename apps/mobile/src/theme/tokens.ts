// Mirrors apps/admin/src/index.css's `@theme` block (light values only — mobile has no dark-mode
// requirement in any issue yet). Source of truth is the *live* admin CSS, not the older
// reference-derived DESIGN-SYSTEM.md doc, which predates the 2026-07-15 red/black/white/gray re-theme.
// No component may hardcode a hex or off-scale spacing value — everything routes through this file.

export const color = {
  brand300: '#f3cbd3',
  brand600: '#b9102b',
  brand700: '#8f0f24',
  // text/icon on a bold color surface (brand button, StatTile) — DESIGN-SYSTEM §1.1 `--brand-on`.
  onColor: '#ffffff',

  chrome900: '#0a0a0c',
  chrome800: '#131316',
  chrome700: '#232329',
  chromeText: '#d6d6db',
  chromeMuted: '#8e8e96',

  surfaceApp: '#f2f3f5',
  surfaceCard: '#ffffff',
  surfaceRaised: '#f7f8fa',
  surfaceSunken: '#ebedf0',

  line: '#e4e6ea',
  lineStrong: '#cbcfd6',

  inkStrong: '#101114',
  ink: '#32343a',
  inkMuted: '#6b6e76',
  inkCaps: '#83868e',

  info: '#1d4ed8',
  infoBg: '#e5eeff',
  success: '#197a3d',
  successBg: '#e3f5e9',
  verified: '#6d28d9',
  verifiedBg: '#eee7fb',
  warning: '#9a6700',
  warningBg: '#fdf2d9',
  critical: '#b42318',
  criticalBg: '#fbe3e3',
  neutral: '#4b5563',
  neutralBg: '#eeeef0',
} as const;

// 4px base scale, same steps as DESIGN-SYSTEM.md §3.1 / admin's Tailwind default.
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  '2xl': 32,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  // DESIGN-SYSTEM §3.3: mobile cards/primary buttons use the larger 14-16px step.
  lg: 16,
  full: 9999,
} as const;

/**
 * Shared soft elevation for cards that should lift off the app background instead of relying on a
 * flat 1px border alone. One definition so every card in the app reads at the same depth — spread
 * this onto a component's own `StyleSheet.create` object (`{ ...shadow.card, ... }`); both platforms
 * are covered (`elevation` for Android, `shadow*` for iOS).
 */
export const shadow = {
  card: {
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
} as const;

export const typeScale = {
  display: { fontSize: 28, fontWeight: '700', lineHeight: 32 },
  pageTitle: { fontSize: 22, fontWeight: '700', lineHeight: 28 },
  sectionTitle: { fontSize: 15, fontWeight: '600', lineHeight: 20 },
  capsLabel: { fontSize: 11, fontWeight: '600', lineHeight: 14, letterSpacing: 0.6, textTransform: 'uppercase' },
  body: { fontSize: 14, fontWeight: '400', lineHeight: 20 },
  cellSecondary: { fontSize: 12, fontWeight: '400', lineHeight: 16 },
} as const;

export type SemanticStatus = 'info' | 'success' | 'verified' | 'warning' | 'critical' | 'neutral';

export function semanticColors(status: SemanticStatus): { fg: string; bg: string } {
  switch (status) {
    case 'info':
      return { fg: color.info, bg: color.infoBg };
    case 'success':
      return { fg: color.success, bg: color.successBg };
    case 'verified':
      return { fg: color.verified, bg: color.verifiedBg };
    case 'warning':
      return { fg: color.warning, bg: color.warningBg };
    case 'critical':
      return { fg: color.critical, bg: color.criticalBg };
    case 'neutral':
      return { fg: color.neutral, bg: color.neutralBg };
  }
}
