/**
 * Auto-recovery ping criteria (CONTEXT "Auto-Recovery"). A Device is considered recovered when it
 * resumes sending GPS pings that satisfy the full three-part evidence rule CONTEXT.md:117 states:
 * **≥3 pings, ≥15 min span, ≥1 h stability**.
 *
 * **#229 — the ≥1 h clause is now implemented here.** It previously was not: this file carried only
 * the first two thresholds and deferred the stability window to "GPS verification (Issue 18), which
 * owns it". That claim was stale — `meetsRecoveryCriteria` has exactly one caller
 * (`AutoRecoveryService`), verification never adopted it, so the weaker predicate was simply the
 * shipped behaviour, diverging from CONTEXT with nothing to reconcile it against.
 *
 * "Stability" is read as **the recovery pings must span at least an hour** — a device that chirped
 * three times inside a quarter-hour and went quiet has not demonstrated it is back. Measured against
 * the live backlog on 2026-08-10 the tightening moves nothing: of the 11,042 tickets satisfying
 * ≥3 pings/≥15 min, all 11,042 also span ≥60 min. It is a divergence closed for free, and it is
 * deliberately **not** the fix for flapping devices — that is a liveness question about *now*, which
 * the caller answers with `device_states.is_inactive`, not one this pure predicate can see.
 *
 * Pure function of the recovery ping timestamps observed after the Failure Cycle opened.
 */
export interface RecoveryThresholds {
  minPings?: number;
  minSpanMinutes?: number;
  /** CONTEXT's ≥1 h stability window. Overridable so a caller may relax it deliberately and visibly. */
  minStabilityMinutes?: number;
}

const DEFAULT_MIN_PINGS = 3;
const DEFAULT_MIN_SPAN_MINUTES = 15;
const DEFAULT_MIN_STABILITY_MINUTES = 60;

/** Ping count and observed span — the evidence behind a pass/fail, surfaced so the dry-run (#229
 *  §5.4.1) can print *why* each ticket qualifies rather than only that it did. */
export interface RecoveryEvidence {
  pingCount: number;
  firstPing: Date | null;
  lastPing: Date | null;
  spanMinutes: number;
}

export function summariseRecoveryPings(pingTimes: readonly Date[]): RecoveryEvidence {
  if (pingTimes.length === 0) return { pingCount: 0, firstPing: null, lastPing: null, spanMinutes: 0 };
  const sorted = pingTimes.map((d) => d.getTime()).sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return {
    pingCount: sorted.length,
    firstPing: new Date(first),
    lastPing: new Date(last),
    spanMinutes: (last - first) / 60_000,
  };
}

export function meetsRecoveryCriteria(
  pingTimes: readonly Date[],
  thresholds: RecoveryThresholds = {},
): boolean {
  return meetsRecoveryEvidence(summariseRecoveryPings(pingTimes), thresholds);
}

/** The same predicate over already-summarised evidence, so a caller that needs the numbers for a
 *  report does not pay for a second sort. */
export function meetsRecoveryEvidence(
  evidence: RecoveryEvidence,
  thresholds: RecoveryThresholds = {},
): boolean {
  const minPings = thresholds.minPings ?? DEFAULT_MIN_PINGS;
  const minSpanMinutes = thresholds.minSpanMinutes ?? DEFAULT_MIN_SPAN_MINUTES;
  const minStabilityMinutes = thresholds.minStabilityMinutes ?? DEFAULT_MIN_STABILITY_MINUTES;
  if (evidence.pingCount < minPings) return false;
  // Both clauses are span-shaped, so the binding one is simply the larger. Kept as two named
  // thresholds because they are two separate sentences in CONTEXT and move independently.
  return evidence.spanMinutes >= Math.max(minSpanMinutes, minStabilityMinutes);
}
