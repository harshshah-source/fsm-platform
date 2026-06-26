// Chart colours mirror the design tokens as concrete hex values (recharts needs colour strings, not
// Tailwind classes). Keep in sync with index.css @theme.
export const CHART = {
  brand: '#c8102e',
  info: '#1d4ed8',
  success: '#197a3d',
  verified: '#6d28d9',
  warning: '#d99100',
  critical: '#b42318',
  criticalDeep: '#7a1b12',
  neutral: '#94a3b8',
  axis: '#8a93a3',
  grid: '#e7e5e1',
} as const;

export const CHART_PALETTE = [
  CHART.brand,
  CHART.info,
  CHART.success,
  CHART.verified,
  CHART.warning,
  CHART.neutral,
];
