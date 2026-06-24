/**
 * Auto-recovery ping criteria (CONTEXT "Auto-Recovery"). A Device is considered recovered when it
 * resumes sending GPS pings that satisfy the evidence rule: **≥3 pings spanning ≥15 minutes**. The
 * fuller three-phase stability window (≥1h) is shared with — and owned by — GPS verification
 * (Issue 18); this is the minimal shared predicate, kept pure so verification can extend it.
 *
 * Pure function of the recovery ping timestamps observed after the Failure Cycle opened.
 */
export interface RecoveryThresholds {
  minPings?: number;
  minSpanMinutes?: number;
}

const DEFAULT_MIN_PINGS = 3;
const DEFAULT_MIN_SPAN_MINUTES = 15;

export function meetsRecoveryCriteria(
  pingTimes: Date[],
  thresholds: RecoveryThresholds = {},
): boolean {
  const minPings = thresholds.minPings ?? DEFAULT_MIN_PINGS;
  const minSpanMinutes = thresholds.minSpanMinutes ?? DEFAULT_MIN_SPAN_MINUTES;
  if (pingTimes.length < minPings) return false;
  const sorted = pingTimes.map((d) => d.getTime()).sort((a, b) => a - b);
  const spanMinutes = (sorted[sorted.length - 1] - sorted[0]) / 60_000;
  return spanMinutes >= minSpanMinutes;
}
