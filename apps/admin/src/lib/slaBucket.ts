// SLA bucket presentation (CONTEXT "SLA Bucket"). Severity order descending; ACTIVE is never a
// bucket (the backend excludes null buckets), so it never appears in any dashboard column.

import { SLA_BANDS } from '@fsm/shared';

export const SLA_BUCKETS = [
  'LONG_PENDING',
  'VERY_SEVERE',
  'SEVERE',
  'HIGH_CRITICAL',
  'CRITICAL',
  'RISK',
  'EARLY_RISK',
  'WARNING',
] as const;

export type SlaBucket = (typeof SLA_BUCKETS)[number];

/**
 * "Critical+" — buckets at or above CRITICAL severity. THE single source of this definition for the
 * whole admin app (KPI cards, the Zone Performance Scorecard, any critical-load surface). It must stay
 * identical everywhere, so no screen may re-declare its own list (Issue 1).
 */
export const CRITICAL_PLUS_BUCKETS: SlaBucket[] = [
  'CRITICAL',
  'HIGH_CRITICAL',
  'SEVERE',
  'VERY_SEVERE',
  'LONG_PENDING',
];

/** Count of critical+ **devices** in one entity's per-bucket distribution. */
export function criticalPlusCount(byBucket: Record<string, number>): number {
  return CRITICAL_PLUS_BUCKETS.reduce((sum, b) => sum + (byBucket[b] ?? 0), 0);
}

/**
 * Count of devices in strictly the CRITICAL band (Issue 122 decision). The dashboard "Critical
 * Devices" KPI + the scorecard "Critical" column use THIS, not `criticalPlusCount` — the operator
 * asked to see only the single CRITICAL bucket, not the whole critical-and-worse range (worse bands
 * — Long-Pending / Severe / … — are still visible in the Zone Overview + SLA distribution).
 */
export function criticalOnlyCount(byBucket: Record<string, number>): number {
  return byBucket.CRITICAL ?? 0;
}

/** Sum of strictly-CRITICAL devices across zones — the canonical "Critical Devices" KPI (Issue 122). */
export function sumCriticalDevices(zones: ReadonlyArray<{ byBucket: Record<string, number> }>): number {
  return zones.reduce((sum, z) => sum + criticalOnlyCount(z.byBucket), 0);
}

/**
 * Sum of critical+ devices across zones — the canonical "Critical+ Devices" KPI. Derived from the same
 * `zone-overview` byBucket data the scorecard renders, so the KPI always equals the scorecard column
 * sum (Issue 1: A + B + C + D = X by construction).
 */
export function sumCriticalPlusDevices(zones: ReadonlyArray<{ byBucket: Record<string, number> }>): number {
  return zones.reduce((sum, z) => sum + criticalPlusCount(z.byBucket), 0);
}

/**
 * Human inactivity-range label per bucket (e.g. `4–8Hr`, `24–48Hr`, `3–5d`, `7d+`), DERIVED from the
 * shared `SLA_BANDS` boundaries — the exact same array the backend classifier uses to bucket a device.
 * Because the ranges are computed here rather than hardcoded, the Settings SLA legend, dashboard cards,
 * overview tables and the device table can never drift from how devices are actually classified;
 * changing a threshold in `@fsm/shared` updates them all at once. Sub-3-day bands read in hours, 3-day+
 * bands in days; the top band (LONG_PENDING) is open-ended (`7d+`). THE single source for these strings
 * (no page may hardcode its own SLA range text).
 */
export const BUCKET_RANGE_LABEL: Record<SlaBucket, string> = buildBucketRangeLabels();

/**
 * The operator-facing SLA bucket label. Per the product-owner request the taxonomy is presented as its
 * inactivity RANGE (e.g. `24–48Hr`, `7d+`) rather than a severity word — so the visible label IS the
 * range. The underlying enum (`CRITICAL`, `LONG_PENDING`, …) and all classification logic are
 * unchanged; only the presentation differs, and it stays sourced from the single `BUCKET_RANGE_LABEL`
 * mapping so no surface can drift.
 */
export const BUCKET_LABEL: Record<SlaBucket, string> = BUCKET_RANGE_LABEL;

/**
 * Combined descriptor per bucket. With the label now already the range, this is the same range string
 * — retained as a named export so the surfaces that asked for `Label (range)` keep working unchanged.
 */
export const BUCKET_LABEL_RANGE: Record<SlaBucket, string> = BUCKET_RANGE_LABEL;

function buildBucketRangeLabels(): Record<SlaBucket, string> {
  const labels = {} as Record<SlaBucket, string>;
  // SLA_BANDS is ordered highest-band-first as [closedLowerBoundHours, bucket]; a band's open upper
  // bound is the lower bound of the band directly above it (∞ for the top band).
  SLA_BANDS.forEach(([lowerBound, bucket], i) => {
    const upperBound = i === 0 ? Infinity : SLA_BANDS[i - 1][0];
    labels[bucket as SlaBucket] = formatBucketRange(lowerBound, upperBound);
  });
  return labels;
}

// Compact range text. Bands whose lower bound is ≥ 3 days read in days (`3–5d`, `7d+`); shorter bands
// read in hours (`4–8Hr` … `48–72Hr`), matching the operator-facing severity table.
function formatBucketRange(lowerHours: number, upperHours: number): string {
  const unit: 'Hr' | 'd' = lowerHours >= 72 ? 'd' : 'Hr';
  const toUnit = (h: number) => (unit === 'd' ? h / 24 : h);
  if (!Number.isFinite(upperHours)) return `${toUnit(lowerHours)}${unit}+`;
  return `${toUnit(lowerHours)}–${toUnit(upperHours)}${unit}`;
}

/**
 * Concrete LIGHT-MODE hex per bucket. Kept for the few places that need a real colour value rather
 * than a CSS reference (canvas paths, exported files, tests). **Charts should use
 * {@link BUCKET_COLOR}**, which re-points with the theme.
 *
 * This is an ORDINAL ramp, not a categorical palette: severity is carried by lightness first and hue
 * second, so it stays readable under red/green colour blindness — deuteranopia collapses the hues but
 * not the light→dark progression. Steps are monotone in OKLab L with a ≥0.06 gap between neighbours.
 * Validated with the dataviz `validate_palette.js --ordinal` checks (monotone L ✓, adjacent ΔL ✓,
 * light-end contrast 2.06:1 ✓); the "single hue" check is a deliberate, documented deviation —
 * PRD:302 specifies the green→red coding, and semantic heat is the sanctioned multi-hue sequential
 * exception, so every surface using it carries a legend.
 *
 * The values live in `index.css` as `--sla-*` and are mirrored here; the two must stay in step.
 */
export const BUCKET_HEX: Record<SlaBucket, string> = {
  LONG_PENDING: '#610017',
  VERY_SEVERE: '#7f0010',
  SEVERE: '#971b00',
  HIGH_CRITICAL: '#a24100',
  CRITICAL: '#ac5f00',
  RISK: '#ab8000',
  EARLY_RISK: '#81aa43',
  WARNING: '#66c58b',
};

/**
 * Theme-aware SLA colour per bucket — a `var(--sla-…)` reference, so a bucket is the same colour in
 * every chart AND re-points on the dark canvas (where the deep-red end would otherwise vanish into
 * the near-black surface). SVG `fill`/`stroke` and CSS `background` resolve these natively.
 *
 * Prefer this over {@link BUCKET_HEX} anywhere the colour is rendered in the app.
 */
export const BUCKET_COLOR: Record<SlaBucket, string> = {
  LONG_PENDING: 'var(--sla-long-pending)',
  VERY_SEVERE: 'var(--sla-very-severe)',
  SEVERE: 'var(--sla-severe)',
  HIGH_CRITICAL: 'var(--sla-high-critical)',
  CRITICAL: 'var(--sla-critical)',
  RISK: 'var(--sla-risk)',
  EARLY_RISK: 'var(--sla-early-risk)',
  WARNING: 'var(--sla-warning)',
};

/**
 * Badge/pill colour coding per the severity table, driven by the SAME ramp as the charts (via the
 * `--sla-*` tokens) so a bucket can never be one colour in a table and another in a chart beside it.
 * Text is white throughout except the two lightest steps, whose lightness (L ≥ 0.69) needs dark ink
 * to stay legible.
 */
export const BUCKET_CLASS: Record<SlaBucket, string> = {
  LONG_PENDING: 'bg-[var(--sla-long-pending)] text-white',
  VERY_SEVERE: 'bg-[var(--sla-very-severe)] text-white',
  SEVERE: 'bg-[var(--sla-severe)] text-white',
  HIGH_CRITICAL: 'bg-[var(--sla-high-critical)] text-white',
  CRITICAL: 'bg-[var(--sla-critical)] text-white',
  RISK: 'bg-[var(--sla-risk)] text-white',
  EARLY_RISK: 'bg-[var(--sla-early-risk)] text-[#14200a]',
  WARNING: 'bg-[var(--sla-warning)] text-[#06210f]',
};
