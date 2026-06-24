// SLA bucket presentation (CONTEXT "SLA Bucket"). Severity order descending; ACTIVE is never a
// bucket (the backend excludes null buckets), so it never appears in any dashboard column.

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

export const BUCKET_LABEL: Record<SlaBucket, string> = {
  LONG_PENDING: 'Long Pending',
  VERY_SEVERE: 'Very Severe',
  SEVERE: 'Severe',
  HIGH_CRITICAL: 'High Critical',
  CRITICAL: 'Critical',
  RISK: 'Risk',
  EARLY_RISK: 'Early Risk',
  WARNING: 'Warning',
};

/** Colour coding per the severity table — deepest red at the top, cooling toward WARNING. */
export const BUCKET_CLASS: Record<SlaBucket, string> = {
  LONG_PENDING: 'bg-red-900 text-white',
  VERY_SEVERE: 'bg-red-700 text-white',
  SEVERE: 'bg-red-500 text-white',
  HIGH_CRITICAL: 'bg-orange-500 text-white',
  CRITICAL: 'bg-amber-400 text-amber-950',
  RISK: 'bg-yellow-300 text-yellow-900',
  EARLY_RISK: 'bg-lime-200 text-lime-900',
  WARNING: 'bg-slate-200 text-slate-700',
};
