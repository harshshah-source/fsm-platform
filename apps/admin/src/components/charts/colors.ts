// Chart colours mirror the design tokens (recharts needs colour strings, not Tailwind classes).
//
// The *chrome* of a chart — axes, gridlines, tick labels — is expressed as `var(--color-…)` rather
// than a frozen hex so it re-points with the theme: on the dark canvas a `#e4e6ea` gridline glares
// and a `#83868e` tick goes muddy. SVG `fill`/`stroke` resolve CSS variables natively, so recharts
// needs no involvement.
//
// The *series* colours stay literal. They are semantic (brand / info / success / critical …), they
// have to stay distinguishable from one another rather than from the background, and recharts hands
// some of them to a canvas-based path where a variable would not resolve. They sit mid-scale, which
// is legible on both canvases. Keep them in sync with index.css @theme.
export const CHART = {
  brand: '#c8102e',
  info: '#1d4ed8',
  success: '#197a3d',
  verified: '#6d28d9',
  warning: '#d99100',
  critical: '#b42318',
  criticalDeep: '#7a1b12',
  neutral: '#9aa0aa',
  axis: 'var(--color-ink-caps)',
  grid: 'var(--color-line)',
} as const;

export const CHART_PALETTE = [
  CHART.brand,
  CHART.info,
  CHART.success,
  CHART.verified,
  CHART.warning,
  CHART.neutral,
];
